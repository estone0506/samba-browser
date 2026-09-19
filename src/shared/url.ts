// 탭에서 열어도 되는 URL 인지 판정하는 순수 함수.
// AI 도구·페이지의 window.open·주소창 입력이 모두 이 관문을 지나야 한다.

// 웹 페이지 로드에 허용하는 프로토콜. file:/javascript:/data: 등은 전부 거부
const WEB_PROTOCOLS = ['http:', 'https:']

// 빈 탭 표시용으로만 허용
const BLANK_URL = 'about:blank'

// === 내부 페이지 (새 탭) ====================================================
// 앱이 직접 제공하는 화면에만 쓰는 내부 스킴. protocol.handle('samba', …) 가 응답한다
export const INTERNAL_SCHEME = 'samba'

// 자체 새 탭 페이지 주소
export const NEW_TAB_URL = 'samba://newtab'

// 내부 페이지 허용 목록 — 여기 없는 samba: 주소는 탭에 열 수 없다
const INTERNAL_URLS: string[] = [NEW_TAB_URL]
// === 내부 페이지 끝 =========================================================

// 거부 시 AI 에게 돌려줄 문자열(도구 결과·오류 메시지 공용)
export const BLOCKED_URL_MESSAGE = 'refused: only http(s) URLs are allowed'

// http/https 인지. 외부 브라우저로 넘길 때(shell.openExternal)는 이 판정만 쓴다
export function isHttpUrl(url: string): boolean {
  try {
    return WEB_PROTOCOLS.includes(new URL(url.trim()).protocol.toLowerCase())
  } catch {
    return false
  }
}

// 내부 페이지 주소인지. 끝의 슬래시와 대소문자 차이는 무시한다
export function isInternalUrl(url: string): boolean {
  const s = url.trim().toLowerCase().replace(/\/+$/, '')
  return INTERNAL_URLS.includes(s)
}

// 탭에 로드해도 되는 URL 인지. http/https 와 about:blank, 내부 페이지만 허용.
// 사용자 탐색 경로(주소창·will-navigate·window.open)의 관문이다
export function isAllowedUrl(url: string): boolean {
  const s = url.trim()
  if (!s) return false
  if (s.toLowerCase() === BLANK_URL) return true
  if (isInternalUrl(s)) return true
  return isHttpUrl(s)
}

// 내부 페이지를 뺀 허용 URL. AI 도구·북마크 저장처럼 사용자 탐색이 아닌 경로가 쓴다
// (AI 가 내부 페이지를 열어 앱 화면을 조작하지 못하게 관문을 분리했다)
export function isAllowedExternalUrl(url: string): boolean {
  return isAllowedUrl(url) && !isInternalUrl(url)
}

// === 확장 페이지 ============================================================
// 확장이 제공하는 문서(팝업·옵션 페이지)의 스킴. 크로미움이 확장별로 격리해 서빙한다
const EXTENSION_PROTOCOL = 'chrome-extension:'

/**
 * 확장 문서 주소인가.
 *
 * 이 판정은 isAllowedUrl 에 넣지 않는다 — 넣으면 주소창 입력·웹페이지의 window.open·
 * AI 도구까지 확장 내부 문서를 열 수 있게 된다. 앱이 스스로 여는 경로
 * (툴바 액션 → 옵션 페이지)에서만 따로 통과시킨다
 */
export function isExtensionUrl(url: string): boolean {
  try {
    return new URL(url.trim()).protocol.toLowerCase() === EXTENSION_PROTOCOL
  } catch {
    return false
  }
}
// === 확장 페이지 끝 =========================================================
