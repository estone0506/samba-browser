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
  // FQDN 끝의 "." (예: "example.com.") 은 DNS 루트 표기일 뿐 동일 호스트이므로 제거한다
  if (host.endsWith('.')) {
    host = host.slice(0, -1)
  }
  return host
}

// 2단계 공공 접미사(eTLD) 목록 — 이 접미사 앞의 라벨까지 포함해야 등록 가능 도메인(eTLD+1)이다.
// 예: "co.kr" 은 그 자체로 등록 단위가 아니라 "11st.co.kr" 처럼 한 단계 더 붙어야 한다.
// 전체 공공 접미사 목록(PSL)을 쓰지 않고 실사용 빈도가 높은 목록만 좁혀 둔 것이다.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.kr',
  'or.kr',
  'ne.kr',
  'go.kr',
  'ac.kr',
  're.kr',
  'pe.kr',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'com.tw',
  'com.hk',
  'co.uk',
  'org.uk',
  'com.au',
  'com.br',
  'com.sg',
  'co.id'
])

// IP 리터럴(v4/v6)·localhost 는 도메인 계층 규칙 대상이 아니므로 registrableDomain 에서 그대로 돌려준다
function isIpOrLocalHost(host: string): boolean {
  if (host === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  // IPv6 literal ("::1", "[::1]" 등 콜론을 포함하는 형태)
  if (host.includes(':')) return true
  return false
}

/**
 * 등록 가능 도메인(eTLD+1)을 반환한다 — 같은 사이트의 서로 다른 서브도메인(예: 로그인 서브도메인과
 * 일반 서브도메인)을 같은 사이트로 취급하기 위해 쓴다.
 * 입력은 이미 정규화된 호스트(또는 원본 호스트)를 그대로 받는다. IP·localhost 는 그대로 돌려준다.
 */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase()
  if (!h) return h
  if (isIpOrLocalHost(h)) return h

  const parts = h.split('.')
  if (parts.length <= 2) return h

  const lastTwo = parts.slice(-2).join('.')
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}
