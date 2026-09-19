// 이미지 번역 — 이미지 속 글자 상자를 뽑아 번역문으로 바꿔 돌려준다.
//
// 흐름
//   1) 로컬 OCR(src/main/ocr) 로 좌표가 있는 글자 상자를 뽑는다
//   2) 로컬 모델(한국어 인식)이 못 읽으면 Visual 모델에 "글자와 위치 JSON" 을 묻는다
//   3) 상자별 텍스트를 번역 서비스에 넘겨 같은 순서로 받는다
//
// 안전 규칙
//  - 이미지 바이트와 모델 응답은 로그·디스크 어디에도 남기지 않는다.
//  - 실패는 조용히 빈 배열이며, 화면에는 오버레이가 뜨지 않는다.

import { z } from 'zod'
import type { ImageTextBox, TranslateLang } from '../../shared/translate'
import { askVisual, type VisualDeps } from '../ai/visual'
import type { OcrLine } from '../ocr/postprocess'

/** 이미지 속 글자와 위치만 묻는다. "무엇을 하라" 는 지시는 넣지 않는다 */
export const IMAGE_TEXT_PROMPT =
  '이 이미지에 보이는 글자를 줄 단위로 읽어 주세요. ' +
  '출력은 JSON 배열 하나로만, 각 원소는 {"t":"글자","x":왼쪽비율,"y":위비율,"w":너비비율,"h":높이비율} 이고 ' +
  '비율은 0~1 사이 소수입니다. 글자가 없으면 [] 만 답하세요. 설명 문장은 쓰지 마세요.'

const visualItemSchema = z.object({
  t: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1)
})
const visualBoxesSchema = z.array(visualItemSchema)

export interface ImageSize {
  width: number
  height: number
}

/** 응답에 섞인 설명·코드펜스를 걷어내고 JSON 배열만 잘라 낸다 */
function sliceJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/**
 * Visual 모델의 0~1 비율 응답을 이미지 픽셀 상자로 환산한다.
 * 파싱에 실패하면 null(= 폴백도 실패), 글자가 없으면 빈 배열이다
 */
export function parseVisualBoxes(text: string, size: ImageSize): ImageTextBox[] | null {
  if (!(size.width > 0) || !(size.height > 0)) return null
  const slice = sliceJsonArray(text)
  if (!slice) return null
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return null
  }
  const parsed = visualBoxesSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
    .map((item) => ({
      x: Math.round(item.x * size.width),
      y: Math.round(item.y * size.height),
      width: Math.round(item.w * size.width),
      height: Math.round(item.h * size.height),
      text: item.t
    }))
    .filter((b) => b.width > 0 && b.height > 0 && b.text.trim().length > 0)
}

/** OCR 결과(줄 + [x,y,w,h])를 공용 상자 타입으로 옮긴다 */
export function ocrLinesToBoxes(lines: readonly OcrLine[]): ImageTextBox[] {
  return lines
    .map((line) => ({
      x: line.box[0],
      y: line.box[1],
      width: line.box[2],
      height: line.box[3],
      text: line.text
    }))
    .filter((b) => b.width > 0 && b.height > 0 && b.text.trim().length > 0)
}

export interface ImageExtractDeps {
  /** 로컬 OCR. 꺼져 있거나 모델이 없으면 null 을 돌려준다 */
  ocr: (png: Buffer) => Promise<OcrLine[] | null>
  /** Visual 모델 폴백(한국어 모델이 못 읽는 일본어·중국어 등) */
  visual: (png: Buffer, size: ImageSize) => Promise<ImageTextBox[] | null>
}

/**
 * 이미지에서 글자 상자를 뽑는다.
 * 로컬 OCR 이 한 줄도 못 읽으면(모델 미보유·다른 언어) Visual 모델로 폴백한다
 */
export async function extractImageBoxes(
  deps: ImageExtractDeps,
  png: Buffer,
  size: ImageSize
): Promise<ImageTextBox[]> {
  let boxes: ImageTextBox[] = []
  try {
    const lines = await deps.ocr(png)
    if (lines) boxes = ocrLinesToBoxes(lines)
  } catch {
    // 로컬 OCR 실패는 폴백으로 넘어갈 이유일 뿐이다(사유는 남기지 않는다)
    boxes = []
  }
  if (boxes.length > 0) return boxes
  try {
    return (await deps.visual(png, size)) ?? []
  } catch {
    return []
  }
}

/** Visual 모델에게 이미지 속 글자와 위치를 묻는다(실패하면 null) */
export async function readImageTextBoxes(
  deps: VisualDeps,
  png: Buffer,
  size: ImageSize
): Promise<ImageTextBox[] | null> {
  const text = await askVisual(deps, png, IMAGE_TEXT_PROMPT)
  if (!text) return null
  return parseVisualBoxes(text, size)
}

export interface ImageTranslateDeps extends ImageExtractDeps {
  translate: (texts: string[], lang: TranslateLang) => Promise<string[]>
}

/**
 * 이미지 한 장을 번역한다. 글자를 못 읽으면 빈 배열이고,
 * 번역이 실패하면 오류를 그대로 올려 호출부가 안내 문구로 바꾼다
 */
export async function translateImage(
  deps: ImageTranslateDeps,
  png: Buffer,
  size: ImageSize,
  lang: TranslateLang
): Promise<ImageTextBox[]> {
  const boxes = await extractImageBoxes(deps, png, size)
  if (boxes.length === 0) return []
  const translated = await deps.translate(
    boxes.map((b) => b.text),
    lang
  )
  return boxes.map((b, i) => ({ ...b, text: translated[i] ?? b.text }))
}
