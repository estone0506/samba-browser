// 호스트 정규화 공용 함수 — 메인/렌더러/공유 코드 어디서나 같은 규칙을 쓴다.
// 소문자화, www. 접두사 제거, 포트 제거, 스킴이 없으면 호스트만 적힌 값으로 간주한다.

// 두 단계짜리 공개 접미사(eTLD). 여기 없는 접미사는 마지막 두 조각을 등록 가능 도메인으로 본다.
// 전체 Public Suffix List 를 번들하면 수백 KB 가 늘어나므로 실제로 자주 쓰는 것만 추린다
const MULTI_PART_SUFFIXES = new Set([
  'co.kr',
  'ne.kr',
  'or.kr',
  'go.kr',
  're.kr',
  'pe.kr',
  'sc.kr',
  'ac.kr',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'com.tw',
  'com.hk',
  'com.sg',
  'com.mx',
  'co.nz',
  'co.in',
  'co.za',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.id',
  // 사용자마다 서브도메인을 나눠 쓰는 공유 호스팅. 이걸 빼면 attacker.vercel.app 이
  // victim.vercel.app 과 같은 등록 도메인으로 묶여 계정이 새기 때문에 반드시 분리한다
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'glitch.me',
  'surge.sh',
  'azurewebsites.net',
  'amazonaws.com',
  'cloudfront.net',
  'blogspot.com',
  'wordpress.com',
  'tistory.com',
  'cafe24.com',
  'imweb.me',
  'wixsite.com',
  'notion.site'
])

// IPv4 주소인지(점으로 나뉜 숫자 4개). 주소는 도메인으로 접지 않는다
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

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

/**
 * 호스트를 "등록 가능 도메인"(eTLD+1)으로 접는다.
 * 예) nid.naver.com · accounts.commerce.naver.com → naver.com,
 *     shop.example.co.kr → example.co.kr
 * 같은 사이트의 서로 다른 서브도메인(로그인 서브도메인 등)을 한 사이트로 취급할 때와
 * 키마스터 목록의 그룹 헤더 키로 쓴다. url 도 호스트도 받으며, 파싱이 안 되면 빈 문자열
 */
export function registrableDomain(urlOrHost: string): string {
  const host = normalizeHost(urlOrHost)
  if (!host) return ''
  // IP 리터럴(v4/v6)·localhost 는 도메인 계층 규칙 대상이 아니므로 그대로 돌려준다
  if (host === 'localhost' || IPV4_RE.test(host) || host.includes(':')) return host
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

/**
 * 등록 도메인 안에서도 실제로 다른 계정(아이디·비밀번호)이 쓰이는 서브도메인 무리.
 * 네이버는 개인 계정(nid·mail·pay …)과 판매자 계정(accounts.commerce.naver.com — 네이버 커머스)이 별개다.
 * 여기 적힌 무리는 그 자체를 하나의 사이트(그룹)로 본다 — 합치기·자동채움 후보·목록 그룹 모두
 */
const SEPARATE_ACCOUNT_GROUPS = ['commerce.naver.com']

/**
 * 키마스터에서 "같은 사이트"로 묶는 키. 보통은 등록 도메인(nid.naver.com·mail.naver.com → naver.com)이고,
 * SEPARATE_ACCOUNT_GROUPS 에 속한 서브도메인은 그 무리 이름(accounts.commerce.naver.com → commerce.naver.com)
 */
export function accountGroupKey(urlOrHost: string): string {
  const host = normalizeHost(urlOrHost)
  if (!host) return ''
  for (const group of SEPARATE_ACCOUNT_GROUPS) {
    if (host === group || host.endsWith(`.${group}`)) return group
  }
  return registrableDomain(host)
}
