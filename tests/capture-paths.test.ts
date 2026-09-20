import { describe, it, expect } from 'vitest'
import { join, sep } from 'node:path'
import {
  isAllowedCaptureDir,
  resolveCaptureDir,
  samePath,
  uniqueCaptureFile
} from '../src/main/capture/paths'
import { DEFAULT_CAPTURE_FOLDER_NAME } from '../src/shared/capture'
import { blitRows, createCanvas, toDeviceStep, type RgbaImage } from '../src/main/capture/stitch'

const DOWNLOADS = join('C:', 'Users', 'test', 'Downloads')

describe('저장 폴더 결정', () => {
  it('설정이 비어 있으면 다운로드 아래 기본 폴더를 만든다', () => {
    const made: string[] = []
    const dir = resolveCaptureDir(
      { configured: '', downloads: DOWNLOADS },
      { exists: () => false, mkdir: (p) => made.push(p) }
    )
    expect(dir).toBe(join(DOWNLOADS, DEFAULT_CAPTURE_FOLDER_NAME))
    expect(made).toEqual([dir])
  })

  it('이미 있는 폴더는 다시 만들지 않는다', () => {
    const made: string[] = []
    resolveCaptureDir(
      { configured: '', downloads: DOWNLOADS },
      { exists: () => true, mkdir: (p) => made.push(p) }
    )
    expect(made).toEqual([])
  })

  it('설정한 폴더를 우선 쓴다', () => {
    const custom = join('D:', '캡처')
    const dir = resolveCaptureDir(
      { configured: `  ${custom}  `, downloads: DOWNLOADS },
      { exists: () => true, mkdir: () => undefined }
    )
    expect(dir).toBe(custom)
  })

  it('설정한 폴더를 만들 수 없으면 기본 폴더로 되돌린다', () => {
    const dir = resolveCaptureDir(
      { configured: join('Z:', '없는드라이브'), downloads: DOWNLOADS },
      {
        exists: (p) => p !== join('Z:', '없는드라이브'),
        mkdir: (p) => {
          if (p === join('Z:', '없는드라이브')) throw new Error('권한 없음')
        }
      }
    )
    expect(dir).toBe(join(DOWNLOADS, DEFAULT_CAPTURE_FOLDER_NAME))
  })
})

describe('파일 경로 규칙', () => {
  const date = new Date(2026, 8, 19, 14, 30, 5)

  it('저장 폴더 아래 YYYYMMDD-HHmmss 파일을 만든다', () => {
    const target = uniqueCaptureFile(DOWNLOADS, date, 'png', () => false)
    expect(target.fileName).toBe('20260919-143005.png')
    expect(target.filePath).toBe(join(DOWNLOADS, '20260919-143005.png'))
  })

  it('같은 이름이 이미 있으면 순번을 올려 덮어쓰지 않는다', () => {
    const taken = new Set([
      join(DOWNLOADS, '20260919-143005.png'),
      join(DOWNLOADS, '20260919-143005-2.png')
    ])
    const target = uniqueCaptureFile(DOWNLOADS, date, 'png', (p) => taken.has(p))
    expect(target.fileName).toBe('20260919-143005-3.png')
  })

  it('비디오는 webm 확장자를 쓴다', () => {
    expect(uniqueCaptureFile(DOWNLOADS, date, 'webm', () => false).fileName).toBe(
      '20260919-143005.webm'
    )
  })
})

// 가로줄에 행 번호를 채운 테스트 이미지
function rows(width: number, height: number, value: (row: number) => number): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    data.fill(value(row), row * width * 4, (row + 1) * width * 4)
  }
  return { width, height, data }
}

describe('전체 페이지 이미지 이어붙이기', () => {
  it('지정한 가로줄만 잘라 원하는 위치에 붙인다', () => {
    const dest = createCanvas(2, 6)
    const src = rows(2, 4, (r) => 10 + r)
    const copied = blitRows(dest, src, { sourceTop: 1, height: 2, destTop: 3 })
    expect(copied).toBe(2)
    expect(dest.data[3 * 2 * 4]).toBe(11)
    expect(dest.data[4 * 2 * 4]).toBe(12)
    // 건드리지 않은 줄은 흰색 그대로다
    expect(dest.data[0]).toBe(255)
  })

  it('경계를 넘는 요청은 잘라 내고 복사한 줄 수를 돌려준다', () => {
    const dest = createCanvas(2, 3)
    const src = rows(2, 4, () => 7)
    expect(blitRows(dest, src, { sourceTop: 0, height: 10, destTop: 2 })).toBe(1)
    expect(blitRows(dest, src, { sourceTop: 0, height: 2, destTop: 3 })).toBe(0)
  })

  it('화면 배율만큼 좌표를 키운다', () => {
    const step = { index: 1, scrollY: 700, sourceTop: 100, height: 700, destTop: 800 }
    expect(toDeviceStep(step, 2)).toEqual({ sourceTop: 200, height: 1400, destTop: 1600 })
    expect(toDeviceStep(step, 1)).toEqual({ sourceTop: 100, height: 700, destTop: 800 })
  })
})

describe('경로 비교(저장 폴더 안인지 판정)', () => {
  it('구분자·끝 구분자가 달라도 같은 폴더로 본다', () => {
    expect(samePath('C:/a/b', 'C:\\a\\b', true)).toBe(true)
    expect(samePath('C:/a/b/', 'C:/a/b', true)).toBe(true)
    expect(samePath('C:/a/./b', 'C:/a/b', true)).toBe(true)
  })

  it('윈도우에서는 대소문자를 가리지 않는다', () => {
    expect(samePath('C:/Users/Me/Pics', 'c:/users/me/pics', true)).toBe(true)
    expect(samePath('C:/Users/Me/Pics', 'c:/users/me/pics', false)).toBe(false)
  })

  it('다른 폴더는 여전히 다르다', () => {
    expect(samePath('C:/a/b', 'C:/a/c', true)).toBe(false)
    expect(samePath('C:/a/b', 'C:/a/b/c', true)).toBe(false)
    expect(samePath('', 'C:/a/b')).toBe(false)
  })
})

// --- I14 settings:set 으로 들어온 저장 폴더 --------------------------------------

describe('isAllowedCaptureDir — 렌더러가 보낸 저장 폴더', () => {
  const HOME = join('C:', 'Users', 'test')

  it('빈 값은 기본 폴더를 쓰겠다는 뜻이라 허용한다', () => {
    expect(isAllowedCaptureDir('', HOME, true)).toBe(true)
    expect(isAllowedCaptureDir('   ', HOME, true)).toBe(true)
  })

  it('홈 폴더 안이면 허용한다(대소문자·끝 구분자 차이 무시)', () => {
    expect(isAllowedCaptureDir(join(HOME, 'Pictures', '캡처'), HOME, true)).toBe(true)
    expect(isAllowedCaptureDir(HOME, HOME, true)).toBe(true)
    expect(isAllowedCaptureDir(join(HOME, 'Downloads') + sep, HOME, true)).toBe(true)
  })

  it('홈 밖·상위 이탈·널 바이트는 막는다', () => {
    expect(isAllowedCaptureDir(join('C:', 'Windows', 'System32'), HOME, true)).toBe(false)
    expect(isAllowedCaptureDir(join(HOME, '..', 'other'), HOME, true)).toBe(false)
    expect(isAllowedCaptureDir(join('C:', 'Users', 'testother'), HOME, true)).toBe(false)
    expect(isAllowedCaptureDir(join(HOME, 'x') + '\u0000y', HOME, true)).toBe(false)
  })

  it('홈 경로를 모르면 빈 값 말고는 받지 않는다', () => {
    expect(isAllowedCaptureDir(join('C:', 'any'), '', true)).toBe(false)
  })
})
