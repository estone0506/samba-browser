// 번역 프롬프트와 응답 파싱 — 순수 함수만 둔다(네트워크·파일 접근 없음).
//
// 규칙: "JSON 배열 in → 같은 순서의 번역 배열 out". 개수가 어긋난 응답은 전부 버린다
// (한 칸이라도 밀리면 엉뚱한 자리에 번역문이 들어가 화면이 깨진다).

import { TRANSLATE_LANG_NAMES, type TranslateLang } from '../../shared/translate'

export const TRANSLATE_SYSTEM_PROMPT = [
  'You are a translation engine embedded in a web browser.',
  'You receive a JSON array of source strings and return a JSON array of translations.',
  'Rules: return the SAME number of elements, in the SAME order.',
  'Translate only — never explain, never merge or split elements, never add markdown.',
  'Keep leading/trailing whitespace, numbers, URLs, emails and code identifiers as-is.',
  'If an element needs no translation, repeat it unchanged.',
  'Output the JSON array and nothing else.'
].join(' ')

/** 번역 요청 프롬프트. 원문은 JSON 배열 한 덩어리로만 싣는다 */
export function buildTranslatePrompt(texts: readonly string[], lang: TranslateLang): string {
  const target = TRANSLATE_LANG_NAMES[lang]
  return [
    `Translate every element of the following JSON array into ${target}.`,
    `Return a JSON array of exactly ${texts.length} string(s), same order, nothing else.`,
    JSON.stringify(texts)
  ].join('\n')
}

/** 응답 텍스트에 섞인 설명·코드펜스를 걷어내고 JSON 배열만 잘라 낸다 */
function sliceJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/**
 * 모델 응답 → 번역 배열.
 * 배열이 아니거나, 원소가 문자열이 아니거나, 개수가 다르면 null(= 실패)이다
 */
export function parseTranslateReply(reply: string, expected: number): string[] | null {
  const slice = sliceJsonArray(reply)
  if (!slice) return null
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return null
  }
  if (!Array.isArray(raw) || raw.length !== expected) return null
  if (!raw.every((v) => typeof v === 'string')) return null
  return raw as string[]
}
