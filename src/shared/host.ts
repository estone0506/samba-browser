// 호스트 정규화 공용 함수 — 메인/렌더러/공유 코드 어디서나 같은 규칙을 쓴다.
// 소문자화, www. 접두사 제거, 포트 제거, 스킴이 없으면 호스트만 적힌 값으로 간주한다.

/** url 또는 호스트 문자열을 정규화한다. 유효하지 않으면 빈 문자열을 반환한다 */
export function normalizeHost(urlOrHost: string): string {
  const trimmed = urlOrHost.trim()
  if (!trimmed) return ''

  let hostname = ''
  try {
    hostname = new URL(trimmed).hostname
  } catch {
    hostname = ''
  }
  if (!hostname) {
    // 스킴이 없거나(예: "example.com:443" 이 콜론 때문에 스킴으로 오인됨) 파싱이 실패한 경우
    // 호스트만 적힌 값으로 간주하고 http:// 를 붙여 재시도
    try {
      hostname = new URL(`http://${trimmed}`).hostname
    } catch {
      return ''
    }
  }

  if (!hostname) return ''

  let host = hostname.toLowerCase()
  if (host.startsWith('www.')) {
    host = host.slice('www.'.length)
  }
  return host
}
