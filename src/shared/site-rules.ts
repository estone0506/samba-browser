// 사이트 규칙 — 같은 계정을 공유하는 도메인 그룹, 알려진 로그인 URL, 비밀번호 변경 URL.
//
// 데이터 출처: Apple password-manager-resources (MIT)
//   https://github.com/apple/password-manager-resources
//   원본 JSON 은 resources/site-rules/ 에 그대로 두고, 라이선스 전문은
//   resources/site-rules/LICENSE-apple-password-manager-resources.md 에 있다.
// 한국 사이트 로그인 URL 목록(KNOWN_LOGIN_URLS)은 우리가 직접 확인해 채웠다.
import sharedCredentials from '../../resources/site-rules/shared-credentials.json'
import changePasswordUrls from '../../resources/site-rules/change-password-URLs.json'
import appends2fa from '../../resources/site-rules/websites-that-append-2fa-to-password.json'

// shared-credentials.json 의 두 가지 형태
// 1) { "shared": [ ... ] }        — 나열된 도메인이 같은 계정을 공유
// 2) { "from": [...], "to": [...] } — from 도메인의 계정이 to 도메인에서도 통한다
interface SharedGroup {
  shared?: string[]
  from?: string[]
  to?: string[]
}

const SHARED_GROUPS = sharedCredentials as SharedGroup[]
const CHANGE_PASSWORD_URLS = changePasswordUrls as Record<string, string>
const APPENDS_2FA = appends2fa as string[]

// 호스트 정규화: 소문자, 포트 제거, 선행 www. 제거
export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
}

// 호스트와 그 상위 도메인들(예: login.11st.co.kr → [login.11st.co.kr, 11st.co.kr, co.kr, kr])
function hostChain(host: string): string[] {
  const parts = normalizeHost(host).split('.')
  const chain: string[] = []
  for (let i = 0; i < parts.length - 1; i++) chain.push(parts.slice(i).join('.'))
  return chain
}

// 같은 계정을 공유하는 도메인 그룹. 자기 자신을 항상 첫 번째로 포함한다.
// 키마스터의 listAccounts 매칭을 이 목록으로 넓히면 예: adobelogin.com 계정으로 adobe.com 로그인 가능
export function sharedCredentialDomains(host: string): string[] {
  const chain = hostChain(host)
  if (chain.length === 0) return []
  const self = chain[0]
  const result = new Set<string>([self])
  for (const group of SHARED_GROUPS) {
    const shared = group.shared ?? []
    const from = group.from ?? []
    const to = group.to ?? []
    const hit = (list: string[]): boolean => list.some((d) => chain.includes(normalizeHost(d)))
    if (shared.length > 0 && hit(shared)) {
      for (const d of shared) result.add(normalizeHost(d))
    }
    // from 쪽에 걸리면 to 도 같은 계정으로 본다(반대 방향은 성립하지 않는다)
    if (from.length > 0 && hit(from)) {
      for (const d of to) result.add(normalizeHost(d))
    }
  }
  return Array.from(result)
}

// 알려진 로그인 URL. 국내 주요 쇼핑몰/포털 위주로 실제 응답을 확인해 채웠다(2026-09 기준).
export const KNOWN_LOGIN_URLS: Record<string, string> = {
  // --- 국내 포털 ---
  'naver.com': 'https://nid.naver.com/nidlogin.login',
  'kakao.com': 'https://accounts.kakao.com/login',
  'daum.net': 'https://logins.daum.net/accounts/signinform.do',
  // --- 국내 쇼핑/커머스 ---
  'coupang.com': 'https://login.coupang.com/login/login.pang',
  'kream.co.kr': 'https://kream.co.kr/login',
  'musinsa.com': 'https://www.musinsa.com/auth/login',
  '11st.co.kr': 'https://login.11st.co.kr/auth/front/login.tmall',
  'gmarket.co.kr': 'https://member.gmarket.co.kr/login/login.asp',
  'auction.co.kr': 'https://signin.auction.co.kr/login/',
  'ssg.com': 'https://member.ssg.com/member/login.ssg',
  'danawa.com': 'https://auth.danawa.com/login',
  'lotteon.com': 'https://www.lotteon.com/p/member/login/common',
  'oliveyoung.co.kr': 'https://www.oliveyoung.co.kr/store/member/getLoginPage.do',
  '29cm.co.kr': 'https://www.29cm.co.kr/mypage/login',
  'wconcept.co.kr': 'https://www.wconcept.co.kr/member/login',
  'a-rt.com': 'https://www.a-rt.com/login',
  'interpark.com': 'https://accounts.interpark.com/login/form',
  'yes24.com': 'https://www.yes24.com/Templates/FTLogIn.aspx',
  'ohou.se': 'https://ohou.se/users/sign_in',
  'nike.com': 'https://www.nike.com/kr/login',
  // --- 해외 ---
  'taobao.com': 'https://login.taobao.com/member/login.jhtml',
  'aliexpress.com': 'https://login.aliexpress.com/',
  'amazon.com': 'https://www.amazon.com/ap/signin',
  'google.com': 'https://accounts.google.com/signin',
  'github.com': 'https://github.com/login'
}

// 호스트에 대응하는 로그인 페이지 URL(모르면 undefined)
export function knownLoginUrl(host: string): string | undefined {
  for (const domain of hostChain(host)) {
    const url = KNOWN_LOGIN_URLS[domain]
    if (url) return url
  }
  return undefined
}

// 비밀번호 변경 페이지 URL(Apple change-password-URLs.json)
export function changePasswordUrl(host: string): string | undefined {
  for (const domain of hostChain(host)) {
    const url = CHANGE_PASSWORD_URLS[domain]
    if (url) return url
  }
  return undefined
}

// 비밀번호 뒤에 2단계 인증 코드를 붙여 입력해야 하는 사이트인지(Apple 규칙)
export function appendsTwoFactorToPassword(host: string): boolean {
  const chain = hostChain(host)
  return APPENDS_2FA.some((d) => chain.includes(normalizeHost(d)))
}
