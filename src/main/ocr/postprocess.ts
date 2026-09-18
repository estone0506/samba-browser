// PP-OCR 후처리 순수 함수 모음.
// ONNX 런타임·파일시스템에 의존하지 않으므로 단위 테스트에서 그대로 쓸 수 있다.

/** 뷰 좌표 기준 사각형 [x, y, width, height] */
export type BoxTuple = [number, number, number, number]

/** 인식 결과 한 줄 */
export interface OcrLine {
  text: string
  box: BoxTuple
  score: number
}

/** 검출 확률맵에서 뽑아낸 원시 영역(확률맵 픽셀 좌표) */
export interface RawRegion {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 영역 내부 평균 확률 */
  score: number
  /** 영역 픽셀 수 */
  area: number
}

/** DB 확률맵 이진화 임계값 — PaddleOCR 기본값과 같다 */
export const DET_BINARY_THRESHOLD = 0.3
/** 영역 평균 확률이 이 값보다 낮으면 잡음으로 보고 버린다 */
export const DET_BOX_THRESHOLD = 0.5
/** 이 픽셀 수보다 작은 덩어리는 잡음으로 보고 버린다 */
export const DET_MIN_AREA = 8

/**
 * DB 확률맵을 이진화한 뒤 4-연결 요소(connected components)를 찾아
 * 각 덩어리의 축 정렬 외접 사각형을 돌려준다.
 *
 * clipper 기반 minAreaRect 대신 축 정렬 근사를 쓴다 — 브라우저 화면의 글자는
 * 거의 수평이라 기울기 보정 없이도 인식률이 충분하다.
 */
export function findRegions(
  prob: ArrayLike<number>,
  width: number,
  height: number,
  binaryThreshold = DET_BINARY_THRESHOLD,
  minArea = DET_MIN_AREA,
  boxThreshold = DET_BOX_THRESHOLD
): RawRegion[] {
  const total = width * height
  if (total <= 0 || prob.length < total) return []
  const seen = new Uint8Array(total)
  const regions: RawRegion[] = []
  // 재귀 대신 명시적 스택 — 큰 글자 덩어리에서 스택 오버플로가 나지 않게 한다
  const stack: number[] = []

  for (let seed = 0; seed < total; seed++) {
    if (seen[seed] || prob[seed] < binaryThreshold) continue
    seen[seed] = 1
    stack.push(seed)
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    let area = 0
    let sum = 0

    while (stack.length > 0) {
      const p = stack.pop() as number
      const py = Math.floor(p / width)
      const px = p - py * width
      area++
      sum += prob[p]
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py

      const push = (q: number): void => {
        if (!seen[q] && prob[q] >= binaryThreshold) {
          seen[q] = 1
          stack.push(q)
        }
      }
      if (px > 0) push(p - 1)
      if (px < width - 1) push(p + 1)
      if (py > 0) push(p - width)
      if (py < height - 1) push(p + width)
    }

    const score = area > 0 ? sum / area : 0
    if (area < minArea || score < boxThreshold) continue
    regions.push({ x0, y0, x1, y1, score, area })
  }
  return regions
}

/**
 * 확률맵 좌표의 영역을 원본 이미지 좌표의 사각형으로 되돌린다.
 * PaddleOCR 의 unclip(다각형 확장) 대신 글자 높이에 비례해 사각형을 넓히는
 * 근사를 쓴다 — 획이 잘려 인식률이 떨어지는 것을 막는 것이 목적이다.
 * 기본 여백 0.4 는 실측으로 고른 값이다(0.25 에서는 한글 받침이 잘려 오인식이 났다).
 */
export function toImageBoxes(
  regions: RawRegion[],
  probWidth: number,
  probHeight: number,
  imageWidth: number,
  imageHeight: number,
  padRatio = 0.4
): { box: BoxTuple; score: number }[] {
  if (probWidth <= 0 || probHeight <= 0) return []
  const sx = imageWidth / probWidth
  const sy = imageHeight / probHeight
  return regions.map((r) => {
    const rawHeight = (r.y1 - r.y0 + 1) * sy
    // padRatio 가 0 이면 여백 없이 정확히 검출 영역만 쓴다(테스트·정밀 크롭용)
    const pad = padRatio <= 0 ? 0 : Math.max(1, rawHeight * padRatio)
    const left = Math.max(0, Math.round(r.x0 * sx - pad))
    const top = Math.max(0, Math.round(r.y0 * sy - pad))
    const right = Math.min(imageWidth, Math.round((r.x1 + 1) * sx + pad))
    const bottom = Math.min(imageHeight, Math.round((r.y1 + 1) * sy + pad))
    return {
      box: [left, top, Math.max(0, right - left), Math.max(0, bottom - top)] as BoxTuple,
      score: r.score
    }
  })
}

/**
 * CTC 탐욕적(greedy) 디코딩.
 * 클래스 0 은 blank, 나머지 k 는 dict[k] 에 대응한다(변환된 PP-OCRv5 사전 규약).
 * 연속 중복을 접고 blank 를 제거한 뒤 문자열과 평균 확신도를 돌려준다.
 */
export function decodeCtc(
  logits: ArrayLike<number>,
  timeSteps: number,
  numClasses: number,
  dict: readonly string[]
): { text: string; score: number } {
  if (timeSteps <= 0 || numClasses <= 0) return { text: '', score: 0 }
  const parts: string[] = []
  let scoreSum = 0
  let kept = 0
  let prev = -1

  for (let t = 0; t < timeSteps; t++) {
    const base = t * numClasses
    let best = 0
    let bestValue = -Infinity
    for (let c = 0; c < numClasses; c++) {
      const v = logits[base + c]
      if (v > bestValue) {
        bestValue = v
        best = c
      }
    }
    // blank(0) 이거나 직전 타임스텝과 같은 클래스면 건너뛴다
    if (best !== 0 && best !== prev) {
      const ch = dict[best]
      if (ch !== undefined) {
        parts.push(ch)
        scoreSum += bestValue
        kept++
      }
    }
    prev = best
  }
  return { text: parts.join(''), score: kept > 0 ? scoreSum / kept : 0 }
}

/**
 * 줄 정렬 — 위에서 아래로, 같은 줄 안에서는 왼쪽에서 오른쪽으로.
 * 같은 줄 판정은 세로 중심 차이가 두 상자 높이의 절반보다 작은지로 한다
 * (글자 크기가 달라도 한 줄로 묶이도록 더 작은 높이를 기준으로 삼는다).
 */
export function sortLines<T extends { box: BoxTuple }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => a.box[1] - b.box[1])
  const rows: T[][] = []
  for (const item of sorted) {
    const centerY = item.box[1] + item.box[3] / 2
    const row = rows.find((r) => {
      const last = r[r.length - 1]
      const lastCenter = last.box[1] + last.box[3] / 2
      const tolerance = Math.min(last.box[3], item.box[3]) / 2
      return Math.abs(centerY - lastCenter) <= tolerance
    })
    if (row) row.push(item)
    else rows.push([item])
  }
  for (const row of rows) row.sort((a, b) => a.box[0] - b.box[0])
  return rows.flat()
}

/** 정렬된 줄들을 사람이 읽을 수 있는 한 덩어리 텍스트로 합친다 */
export function mergeLineText(lines: readonly OcrLine[]): string {
  const sorted = sortLines(lines)
  const out: string[] = []
  let prevCenter: number | null = null
  let prevHeight = 0
  for (const line of sorted) {
    if (!line.text) continue
    const center = line.box[1] + line.box[3] / 2
    const sameRow =
      prevCenter !== null && Math.abs(center - prevCenter) <= Math.min(prevHeight, line.box[3]) / 2
    if (sameRow && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.text}`
    else out.push(line.text)
    prevCenter = center
    prevHeight = line.box[3]
  }
  return out.join('\n')
}

/** 응답이 컨텍스트를 잡아먹지 않도록 길이를 제한한다 */
export function clipText(value: string, max: number): string {
  if (max <= 0) return ''
  return value.length <= max ? value : `${value.slice(0, max)}…(truncated)`
}
