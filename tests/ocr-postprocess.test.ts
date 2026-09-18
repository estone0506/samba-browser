import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clipText,
  decodeCtc,
  findRegions,
  mergeLineText,
  sortLines,
  toImageBoxes,
  type BoxTuple
} from '../src/main/ocr/postprocess'
import { clampRect } from '../src/main/agent/tools-ocr'

// 테스트용 작은 사전. 0번은 CTC blank 자리라 실제로는 쓰이지 않는다
const DICT = ['#', '가', '나', '다', ' ', '1', '2', '3']

/** [t][c] 확률표를 1차원 logits 로 편다 */
function logitsOf(rows: number[][]): { data: Float32Array; t: number; c: number } {
  const t = rows.length
  const c = rows[0].length
  const data = new Float32Array(t * c)
  rows.forEach((row, i) => row.forEach((v, j) => (data[i * c + j] = v)))
  return { data, t, c }
}

/** 특정 클래스만 확신도 conf 로 세운 한 타임스텝 */
function step(cls: number, conf = 0.9, size = DICT.length): number[] {
  const row = new Array<number>(size).fill(0.01)
  row[cls] = conf
  return row
}

const box = (x: number, y: number, w: number, h: number): BoxTuple => [x, y, w, h]

describe('decodeCtc', () => {
  it('blank 를 건너뛰고 연속 중복을 접어 문자열을 만든다', () => {
    // 가 가 blank 나 나 blank 다  ->  "가나다"
    const { data, t, c } = logitsOf([step(1), step(1), step(0), step(2), step(2), step(0), step(3)])
    expect(decodeCtc(data, t, c, DICT).text).toBe('가나다')
  })

  it('blank 없이 같은 글자가 이어지면 하나로 접힌다', () => {
    const { data, t, c } = logitsOf([step(5), step(5), step(5)])
    expect(decodeCtc(data, t, c, DICT).text).toBe('1')
  })

  it('blank 로 분리된 같은 글자는 두 번 살아남는다', () => {
    const { data, t, c } = logitsOf([step(5), step(0), step(5)])
    expect(decodeCtc(data, t, c, DICT).text).toBe('11')
  })

  it('한글·공백·숫자를 섞어 사전 그대로 매핑한다', () => {
    const { data, t, c } = logitsOf([step(1), step(2), step(3), step(4), step(5), step(6), step(7)])
    expect(decodeCtc(data, t, c, DICT).text).toBe('가나다 123')
  })

  it('살아남은 타임스텝의 평균 확신도를 돌려준다', () => {
    const { data, t, c } = logitsOf([step(1, 0.8), step(0, 0.99), step(2, 0.6)])
    const r = decodeCtc(data, t, c, DICT)
    expect(r.text).toBe('가나')
    expect(r.score).toBeCloseTo(0.7, 5)
  })

  it('전부 blank 면 빈 문자열과 0 점을 돌려준다', () => {
    const { data, t, c } = logitsOf([step(0), step(0)])
    expect(decodeCtc(data, t, c, DICT)).toEqual({ text: '', score: 0 })
  })

  it('사전에 없는 클래스는 조용히 버린다', () => {
    const { data, t, c } = logitsOf([step(1), step(DICT.length - 1)])
    // 사전 길이를 넘는 클래스가 나와도 예외를 던지지 않아야 한다
    expect(decodeCtc(data, t, c, ['#', '가']).text).toBe('가')
  })

  it('타임스텝이나 클래스 수가 0 이면 빈 결과다', () => {
    expect(decodeCtc(new Float32Array(0), 0, 0, DICT)).toEqual({ text: '', score: 0 })
  })
})

describe('sortLines', () => {
  it('위에서 아래로 정렬한다', () => {
    const items = [
      { box: box(0, 200, 50, 20), id: 'c' },
      { box: box(0, 0, 50, 20), id: 'a' },
      { box: box(0, 100, 50, 20), id: 'b' }
    ]
    expect(sortLines(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('같은 줄 안에서는 왼쪽에서 오른쪽으로 정렬한다', () => {
    const items = [
      { box: box(300, 12, 50, 20), id: 'r' },
      { box: box(10, 10, 50, 20), id: 'l' },
      { box: box(150, 11, 50, 20), id: 'm' }
    ]
    expect(sortLines(items).map((i) => i.id)).toEqual(['l', 'm', 'r'])
  })

  it('줄이 여러 개면 줄 순서 먼저, 그다음 가로 순서다', () => {
    const items = [
      { box: box(200, 100, 50, 20), id: '2r' },
      { box: box(200, 0, 50, 20), id: '1r' },
      { box: box(0, 100, 50, 20), id: '2l' },
      { box: box(0, 2, 50, 20), id: '1l' }
    ]
    expect(sortLines(items).map((i) => i.id)).toEqual(['1l', '1r', '2l', '2r'])
  })

  it('원본 배열을 바꾸지 않는다', () => {
    const items = [{ box: box(0, 50, 10, 10) }, { box: box(0, 0, 10, 10) }]
    const copy = [...items]
    sortLines(items)
    expect(items).toEqual(copy)
  })

  it('빈 입력은 빈 배열이다', () => {
    expect(sortLines([])).toEqual([])
  })
})

describe('mergeLineText', () => {
  it('같은 줄은 공백으로, 다른 줄은 줄바꿈으로 잇는다', () => {
    const text = mergeLineText([
      { text: '123', box: box(200, 10, 60, 20), score: 0.9 },
      { text: '인증번호', box: box(10, 12, 80, 20), score: 0.9 },
      { text: '유효시간 3분', box: box(10, 100, 120, 20), score: 0.9 }
    ])
    expect(text).toBe('인증번호 123\n유효시간 3분')
  })

  it('빈 텍스트 줄은 건너뛴다', () => {
    const text = mergeLineText([
      { text: '', box: box(0, 0, 10, 10), score: 0.9 },
      { text: '가나다', box: box(0, 60, 40, 20), score: 0.9 }
    ])
    expect(text).toBe('가나다')
  })

  it('줄이 없으면 빈 문자열이다', () => {
    expect(mergeLineText([])).toBe('')
  })
})

describe('findRegions / toImageBoxes', () => {
  // 8x8 확률맵에 서로 떨어진 두 덩어리를 그린다
  const W = 8
  const H = 8
  const prob = new Float32Array(W * H)
  const paint = (x0: number, y0: number, x1: number, y1: number, v: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) prob[y * W + x] = v
  }
  paint(1, 1, 3, 2, 0.9)
  paint(5, 5, 6, 7, 0.8)

  it('떨어진 덩어리를 각각 찾아 외접 사각형을 만든다', () => {
    const regions = findRegions(prob, W, H, 0.3, 4)
    expect(regions).toHaveLength(2)
    const first = regions.find((r) => r.x0 === 1)
    expect(first).toMatchObject({ x0: 1, y0: 1, x1: 3, y1: 2, area: 6 })
    expect(first?.score).toBeCloseTo(0.9, 5)
  })

  it('최소 면적보다 작은 잡음은 버린다', () => {
    const noisy = new Float32Array(prob)
    noisy[0] = 0.95 // 픽셀 1개짜리 잡음
    expect(findRegions(noisy, W, H, 0.3, 4)).toHaveLength(2)
  })

  it('평균 확률이 박스 임계값보다 낮으면 버린다', () => {
    expect(findRegions(prob, W, H, 0.3, 4, 0.85)).toHaveLength(1)
  })

  it('확률맵 좌표를 원본 이미지 좌표로 되돌리고 여백을 붙인다', () => {
    const regions = findRegions(prob, W, H, 0.3, 4)
    const boxes = toImageBoxes(regions, W, H, 80, 80, 0)
    const first = boxes.find((b) => b.box[0] === 10)
    // x0=1..x1=3 → 10..40, y0=1..y1=2 → 10..30 (배율 10, 여백 0)
    expect(first?.box).toEqual([10, 10, 30, 20])
  })

  it('여백을 붙여도 이미지 밖으로 나가지 않는다', () => {
    const boxes = toImageBoxes(
      [{ x0: 0, y0: 0, x1: 7, y1: 7, score: 1, area: 64 }],
      W,
      H,
      80,
      80,
      2
    )
    expect(boxes[0].box).toEqual([0, 0, 80, 80])
  })

  it('크기가 0 이면 빈 배열이다', () => {
    expect(findRegions(new Float32Array(0), 0, 0)).toEqual([])
    expect(toImageBoxes([], 0, 0, 10, 10)).toEqual([])
  })
})

describe('clipText', () => {
  it('상한 이하면 그대로 둔다', () => {
    expect(clipText('가나다', 10)).toBe('가나다')
  })

  it('상한을 넘으면 자르고 표시를 붙인다', () => {
    expect(clipText('abcdef', 3)).toBe('abc…(truncated)')
  })

  it('상한이 0 이하면 빈 문자열이다', () => {
    expect(clipText('abc', 0)).toBe('')
  })
})

describe('clampRect', () => {
  it('뷰 안에 들어오는 영역은 그대로 둔다', () => {
    expect(clampRect({ x: 10, y: 20, width: 100, height: 50 }, 800, 600)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50
    })
  })

  it('뷰 밖으로 삐져나간 영역은 잘라 낸다', () => {
    expect(clampRect({ x: 700, y: 500, width: 400, height: 400 }, 800, 600)).toEqual({
      x: 700,
      y: 500,
      width: 100,
      height: 100
    })
  })

  it('음수 좌표는 0 으로 올린다', () => {
    expect(clampRect({ x: -50, y: -10, width: 100, height: 40 }, 800, 600)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40
    })
  })
})

// --- 실제 모델 추론 --------------------------------------------------------
// 모델은 저장소에 커밋하지 않으므로, 내려받아 둔 환경에서만 돌린다.
const modelsDir = join(process.env.APPDATA ?? '', 'SAMBA Browser', 'models', 'ocr')
const fixture = join(__dirname, 'fixtures', 'ocr-sample.png')
const modelsReady =
  process.platform === 'win32' &&
  ['det.onnx', 'rec.onnx', 'dict.txt'].every((f) => existsSync(join(modelsDir, f))) &&
  existsSync(fixture)

describe.runIf(modelsReady)('OcrEngine (모델이 있을 때만)', () => {
  it('fixture PNG 에서 "가나다 123" 을 60% 이상 맞춘다', async () => {
    const { OcrEngine } = await import('../src/main/ocr/engine')
    const engine = new OcrEngine(modelsDir)
    const result = await engine.recognize(readFileSync(fixture))
    const expected = '가나다 123'
    // 공백을 뺀 글자 단위로 겹치는 비율을 센다
    const got = result.text.replace(/\s/g, '')
    const want = expected.replace(/\s/g, '')
    const pool = [...got]
    let hit = 0
    for (const ch of want) {
      const i = pool.indexOf(ch)
      if (i >= 0) {
        hit++
        pool.splice(i, 1)
      }
    }
    expect(result.lines.length).toBeGreaterThan(0)
    expect(hit / want.length).toBeGreaterThanOrEqual(0.6)
    await engine.dispose()
  }, 120_000)
})
