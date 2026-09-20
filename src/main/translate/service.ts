// 번역 엔진과 그 앞의 캐시 계층.
//
// 구조
//   Translator          — "원문 배열 → 같은 순서의 번역 배열" 인터페이스
//   AiTranslator        — 설정된 AI 제공자(Claude 구독 / 내 API 키)에 Fast 등급 모델로 묻는다
//   TranslateService    — 캐시(메모리+디스크)를 앞에 두고 빠진 것만 엔진에 보낸다
//
// 안전 규칙
//  - 전송하는 것은 화면에 이미 보이는 텍스트뿐이다(입력값·비밀번호는 수집 단계에서 빠진다).
//  - AI 연결이 없으면 호출 없이 NEEDS_AI 오류를 던지고, 화면이 "AI 연결 필요" 를 안내한다.

import {
  TRANSLATE_MAX_CHARS,
  TRANSLATE_MAX_NODES,
  TRANSLATE_MAX_TEXT,
  type TranslateLang
} from '../../shared/translate'
import { buildTranslatePrompt, parseTranslateReply, TRANSLATE_SYSTEM_PROMPT } from './prompt'
import type { TranslateCache } from './cache'

/** AI 연결이 없을 때 던지는 오류 메시지. 렌더러가 안내 카드로 바꿔 보여 준다 */
export const NEEDS_AI_ERROR = 'translate:needs-ai'

/** 번역 엔진 공통 인터페이스 */
export interface Translator {
  translate(texts: string[], lang: TranslateLang): Promise<string[]>
}

/** 모델에게 프롬프트 한 덩어리를 묻고 텍스트만 돌려받는 최소 호출(테스트는 가짜를 주입한다) */
export type AskText = (input: {
  model: string
  system: string
  prompt: string
}) => Promise<string | null>

export interface AiTranslatorDeps {
  ask: AskText
  /** resolveModel(settings.taskModels, 'fast', settings.aiProvider) 결과 */
  model: () => string
}

/** 요청 한 덩어리가 상한을 넘지 않는지 확인한다(격리 월드에서 온 값은 믿지 않는다) */
export function isValidBatch(texts: readonly string[]): boolean {
  if (texts.length === 0 || texts.length > TRANSLATE_MAX_NODES) return false
  let chars = 0
  for (const t of texts) {
    if (typeof t !== 'string') return false
    chars += t.length
  }
  // 긴 문단 하나가 통째로 온 경우는 clampSource 가 잘라 보내므로 총량 규칙에서 빼 준다
  // (배치 상한을 줄인 뒤에도 긴 본문 한 덩어리가 통째로 실패하지 않게 한다)
  if (texts.length === 1) return true
  return chars <= TRANSLATE_MAX_CHARS * 2
}

/** 지나치게 긴 원문은 잘라서 보낸다(모델 응답이 통째로 잘리는 것을 막는다) */
export function clampSource(text: string): string {
  return text.length > TRANSLATE_MAX_TEXT ? text.slice(0, TRANSLATE_MAX_TEXT) : text
}

export class AiTranslator implements Translator {
  constructor(private readonly deps: AiTranslatorDeps) {}

  async translate(texts: string[], lang: TranslateLang): Promise<string[]> {
    if (texts.length === 0) return []
    const sources = texts.map(clampSource)
    const reply = await this.deps.ask({
      model: this.deps.model(),
      system: TRANSLATE_SYSTEM_PROMPT,
      prompt: buildTranslatePrompt(sources, lang)
    })
    if (!reply) throw new Error(NEEDS_AI_ERROR)
    const parsed = parseTranslateReply(reply, sources.length)
    // 개수가 어긋난 응답은 자리 밀림을 만들기 때문에 부분 적용하지 않는다
    if (!parsed) throw new Error('translate:bad-reply')
    return parsed
  }
}

export interface TranslateServiceDeps {
  /** AI 연결이 없으면 null 을 돌려준다 */
  translator: () => Translator | null
  cache: TranslateCache
}

export class TranslateService {
  /**
   * 지금 모델에 물어보는 중인 원문. 화면 번역은 배치를 동시에 여러 개 띄우는데,
   * 같은 문장이 여러 배치에 들어 있으면(머리말·버튼 같은 반복 문구) 같은 값을
   * 두 번 물어보게 된다 — 먼저 시작한 쪽의 약속을 함께 기다린다
   */
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(private readonly deps: TranslateServiceDeps) {}

  private static key(lang: TranslateLang, text: string): string {
    return `${lang}\u0000${text}`
  }

  /**
   * 캐시에 있는 것은 그대로 쓰고, 빠진 것만 엔진에 보낸다.
   * 같은 배치 안의 중복과 다른 배치가 이미 물어본 문장은 한 번만 보낸다.
   * 반환 배열은 입력과 같은 길이·순서다
   */
  async translate(texts: string[], lang: TranslateLang): Promise<string[]> {
    if (!isValidBatch(texts)) throw new Error('translate:too-large')
    const { cache } = this.deps
    const out: string[] = new Array<string>(texts.length)
    // 기다려야 하는 자리와 그 원문
    const waits: Array<{ index: number; text: string }> = []
    // 이번에 처음 보는 원문(중복 제거)
    const fresh: string[] = []
    const freshSeen = new Set<string>()
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]
      const hit = cache.get(lang, text)
      if (hit !== undefined) {
        out[i] = hit
        continue
      }
      waits.push({ index: i, text })
      const key = TranslateService.key(lang, text)
      if (this.inflight.has(key) || freshSeen.has(text)) continue
      freshSeen.add(text)
      fresh.push(text)
    }
    if (fresh.length > 0) {
      const translator = this.deps.translator()
      if (!translator) throw new Error(NEEDS_AI_ERROR)
      const batch = translator.translate(fresh, lang)
      fresh.forEach((text, i) => {
        const key = TranslateService.key(lang, text)
        const one = batch.then((translated) => {
          const value = translated[i] ?? text
          cache.set(lang, text, value)
          return value
        })
        this.inflight.set(key, one)
        // 성공이든 실패든 끝나면 표에서 뺀다(실패를 캐시처럼 물려주지 않는다)
        void one
          .catch(() => undefined)
          .then(() => {
            if (this.inflight.get(key) === one) this.inflight.delete(key)
          })
      })
      void batch.then(() => cache.flush()).catch(() => undefined)
    }
    const values = await Promise.all(
      waits.map(
        (w) =>
          this.inflight.get(TranslateService.key(lang, w.text)) ?? cacheOrSelf(cache, lang, w.text)
      )
    )
    waits.forEach((w, i) => {
      out[w.index] = values[i]
    })
    return out
  }
}

/** 기다리던 약속이 이미 끝나 표에서 빠진 경우 — 캐시를 보고, 없으면 원문을 그대로 쓴다 */
function cacheOrSelf(cache: TranslateCache, lang: TranslateLang, text: string): Promise<string> {
  return Promise.resolve(cache.get(lang, text) ?? text)
}
