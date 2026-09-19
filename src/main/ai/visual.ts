// Visual 모델 호출 — 화면 속 인증번호 읽기와 보안 키패드 배치 인식.
//
// 안전 규칙(3단계 Global Constraints):
//  - 모델에게 "무엇을 입력하라" 고 시키지 않는다. 화면에 보이는 것만 묻는다.
//  - 키패드는 **배치만** 묻는다 — 비밀번호 값은 이 모듈을 스치지도 않는다.
//  - 응답 본문·API 키·이미지는 로그·디스크 어디에도 남기지 않는다(실패해도 조용히 null).
//  - 로컬 GGUF(Qwen2.5-VL) 경로는 4단계 이후로 미룬다. 키가 없으면 호출 없이 null 을
//    돌려주고, 호출부가 "설정 → AI 연결" 안내 카드를 띄운다.

import { z } from 'zod'

/** 이 모듈이 쓰는 최소 fetch 모양(테스트에서 가짜를 주입한다) */
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export interface VisualDeps {
  fetch?: FetchLike
  /** 내 API 키(없으면 null). 값을 보관하지 않고 호출 순간에만 읽는다 */
  apiKey: () => string | null
  /** resolveModel(settings.taskModels, 'visual', settings.aiProvider) 결과 */
  model: () => string
}

export interface KeypadLayout {
  // 숫자 → 화면 좌표(폰 픽셀). 보안 키패드는 매번 배치가 달라 화면마다 새로 구한다
  digits: Record<string, { x: number; y: number }>
}

export interface ScreenSize {
  width: number
  height: number
}

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
const CALL_TIMEOUT_MS = 20_000
const MAX_TOKENS = 512

// 화면에서 인증번호만 읽어 온다. "무엇을 입력하라" 는 지시는 절대 넣지 않는다
export const CODE_PROMPT =
  '이 스크린샷에 보이는 본인확인 인증번호(4~8자리 숫자)만 한 줄로 답하세요. 없으면 NONE 이라고만 답하세요.'

// 보안 키패드 배치만 묻는다. 어떤 숫자를 누를지는 묻지 않는다(값은 모델에 가지 않는다)
export const KEYPAD_PROMPT =
  '이 스크린샷은 숫자 키패드입니다. 0부터 9까지 각 숫자가 화면의 어느 위치에 있는지만 알려주세요. ' +
  '출력은 JSON 배열 하나로만, 각 원소는 {"d":"숫자","x":가로비율,"y":세로비율} 이고 비율은 0~1 사이 소수입니다. ' +
  '설명 문장은 쓰지 마세요.'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

// 모델 응답에서 우리가 읽는 부분만 좁힌 스키마(나머지 필드는 무시한다)
const replySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional()
})

// 키패드 배치 응답 한 칸. 좌표는 0~1 비율이어야 하고, 벗어나면 화면 밖으로 보고 버린다
const keypadItemSchema = z.object({
  d: z.string().regex(/^[0-9]$/),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
})
const keypadSchema = z.array(keypadItemSchema)

/**
 * 이미지 한 장 + 프롬프트 한 줄을 보내고 모델이 낸 텍스트만 돌려준다.
 * 실패(키 없음·비200·네트워크 오류)는 전부 null 이며 사유를 기록하지 않는다 —
 * 응답 본문에는 비밀번호 화면의 내용이 실릴 수 있다
 */
async function askVisual(deps: VisualDeps, png: Buffer, prompt: string): Promise<string | null> {
  const key = deps.apiKey()
  if (!key || !key.trim()) return null
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!doFetch) return null

  const body = JSON.stringify({
    model: deps.model(),
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') }
          },
          { type: 'text', text: prompt }
        ]
      }
    ]
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  timer.unref?.()
  try {
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key.trim(),
        'anthropic-version': API_VERSION,
        'content-type': 'application/json'
      },
      body,
      signal: controller.signal
    })
    if (!res.ok) return null
    const parsed = replySchema.safeParse(JSON.parse(await res.text()))
    if (!parsed.success) return null
    const text = (parsed.data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim()
    return text || null
  } catch {
    // 오류 객체에도 요청 본문(이미지)이 실릴 수 있으므로 남기지 않는다
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 모델 답변에서 4~8자리 숫자 한 덩어리만 뽑는다. 없으면 null */
export function extractCode(text: string): string | null {
  const m = /(?<![0-9])([0-9]{4,8})(?![0-9])/.exec(text)
  return m ? m[1] : null
}

/** 스크린샷에서 본인확인 인증번호를 읽는다. 읽지 못하면 null */
export async function readCodeFromImage(deps: VisualDeps, png: Buffer): Promise<string | null> {
  const text = await askVisual(deps, png, CODE_PROMPT)
  if (!text) return null
  return extractCode(text)
}

/** 응답 텍스트에 섞인 설명·코드펜스를 걷어내고 JSON 배열만 잘라 낸다 */
function sliceJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/**
 * 키패드 배치 응답(0~1 비율 좌표)을 화면 픽셀 좌표로 환산한다.
 * 0~9 가 전부 있고 좌표가 화면 안일 때만 배치를 돌려준다 —
 * 부분 배치로는 비밀번호를 누르지 않는다
 */
export function parseKeypadResponse(text: string, size: ScreenSize): KeypadLayout | null {
  if (!(size.width > 0) || !(size.height > 0)) return null
  const slice = sliceJsonArray(text)
  if (!slice) return null
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return null
  }
  const parsed = keypadSchema.safeParse(raw)
  if (!parsed.success) return null

  const digits: Record<string, { x: number; y: number }> = {}
  for (const item of parsed.data) {
    // 같은 숫자가 두 번 오면 어느 칸인지 확정할 수 없으므로 배치 전체를 버린다
    if (digits[item.d]) return null
    digits[item.d] = { x: Math.round(item.x * size.width), y: Math.round(item.y * size.height) }
  }
  if (DIGITS.some((d) => digits[d] === undefined)) return null
  return { digits }
}

/** 보안 키패드 배치를 Visual 모델에게 묻는다(값이 아니라 위치만). 불완전하면 null */
export async function readKeypadLayout(
  deps: VisualDeps,
  png: Buffer,
  size: ScreenSize
): Promise<KeypadLayout | null> {
  const text = await askVisual(deps, png, KEYPAD_PROMPT)
  if (!text) return null
  return parseKeypadResponse(text, size)
}
