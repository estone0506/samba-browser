// 탭에서 열어도 되는 URL 인지 판정하는 순수 함수.
// AI 도구·페이지의 window.open·주소창 입력이 모두 이 관문을 지나야 한다.

// 웹 페이지 로드에 허용하는 프로토콜. file:/javascript:/data: 등은 전부 거부
const WEB_PROTOCOLS = ['http:', 'https:']

// 빈 탭 표시용으로만 허용
const BLANK_URL = 'about:blank'

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

// 탭에 로드해도 되는 URL 인지. http/https 와 about:blank 만 허용
export function isAllowedUrl(url: string): boolean {
  const s = url.trim()
  if (!s) return false
  if (s.toLowerCase() === BLANK_URL) return true
  return isHttpUrl(s)
}
