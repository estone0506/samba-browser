// 화면(페이지) 번역 · 이미지 번역 공용 타입과 순수 규칙.
//
// 안전 규칙
//  - 입력값(특히 비밀번호 칸)은 번역 대상이 아니다. 수집은 "화면에 보이는 텍스트 노드" 뿐이다.
//  - 이 파일에는 API 키·비밀값이 담기는 타입이 하나도 없다.
//  - preload(page*.ts) 는 이 파일에서 **값**을 import 하지 못한다(page-constants 에 사본을 둔다).

// 대상 언어 — 기본은 한국어
export const TRANSLATE_LANGS = ['ko', 'en', 'ja', 'zh'] as const
export type TranslateLang = (typeof TRANSLATE_LANGS)[number]

export const DEFAULT_TRANSLATE_LANG: TranslateLang = 'ko'

// 프롬프트에 넣을 언어 이름(모델이 알아듣는 표기)
export const TRANSLATE_LANG_NAMES: Record<TranslateLang, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Simplified Chinese'
}

// 한 요청에 담는 최대 노드 수와 텍스트 총량(바이트가 아니라 문자 수)
export const TRANSLATE_MAX_NODES = 100
export const TRANSLATE_MAX_CHARS = 4096

// 디스크 캐시 최대 보관 건수(LRU)
export const TRANSLATE_CACHE_LIMIT = 10000

// 번역할 값 하나가 너무 길면(예: 통째로 붙은 본문) 잘라서 보낸다
export const TRANSLATE_MAX_TEXT = 2000

// AI 연결이 없을 때 렌더러가 보여 줄 안내 i18n 키(평문 문장이 아니다)
export const TRANSLATE_NEEDS_AI = 'translate.needsAi'

/** 격리 월드 preload → 메인 번역 요청 */
export interface TranslateRequest {
  lang: TranslateLang
  texts: string[]
}

/** 이미지 속 글자 상자 하나. 좌표는 원본 이미지 픽셀 기준이다 */
export interface ImageTextBox {
  x: number
  y: number
  width: number
  height: number
  text: string
}

/** 메인 → 격리 월드 이미지 오버레이 payload */
export interface ImageTranslateDto {
  /** 우클릭한 이미지의 src(페이지에서 같은 이미지를 다시 찾는 열쇠) */
  src: string
  /** 원본 이미지 픽셀 크기 — 화면 좌표 환산 기준 */
  naturalWidth: number
  naturalHeight: number
  boxes: ImageTextBox[]
}

export function isTranslateLang(v: unknown): v is TranslateLang {
  return typeof v === 'string' && (TRANSLATE_LANGS as readonly string[]).includes(v)
}

/**
 * 사용자가 입력한 자동 번역 도메인을 비교용으로 다듬는다.
 * 'HTTPS://WWW.Example.com/path?q=1' → 'example.com'
 */
export function normalizeAutoDomain(input: string): string {
  let value = input.trim().toLowerCase()
  if (!value) return ''
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split('/')[0].split('?')[0].split('#')[0]
  // 포트와 사용자정보는 도메인 비교에 쓰지 않는다
  value = value.split('@').pop() ?? value
  value = value.split(':')[0]
  if (value.startsWith('www.')) value = value.slice(4)
  // 남은 문자가 도메인 모양이 아니면 버린다(공백·따옴표 등 오입력 방지)
  return /^[a-z0-9.-]+$/.test(value) ? value : ''
}

/** 이 호스트가 자동 번역 목록에 걸리는가(정확히 일치하거나 하위 도메인이면 걸린다) */
export function shouldAutoTranslate(host: string, domains: readonly string[]): boolean {
  const target = normalizeAutoDomain(host)
  if (!target) return false
  return domains.some((raw) => {
    const d = normalizeAutoDomain(raw)
    return !!d && (target === d || target.endsWith(`.${d}`))
  })
}

/** 목록에 도메인을 더한다(정규화 + 중복 제거). 잘못된 입력이면 원래 목록 그대로 */
export function addAutoDomain(domains: readonly string[], input: string): string[] {
  const d = normalizeAutoDomain(input)
  if (!d) return [...domains]
  const next = domains.map(normalizeAutoDomain).filter(Boolean)
  return next.includes(d) ? next : [...next, d]
}

/** 목록에서 도메인을 뺀다 */
export function removeAutoDomain(domains: readonly string[], input: string): string[] {
  const d = normalizeAutoDomain(input)
  return domains.map(normalizeAutoDomain).filter((v) => !!v && v !== d)
}
