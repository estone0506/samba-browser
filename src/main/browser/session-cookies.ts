// 세션 쿠키 유지 — 앱을 닫아도 로그인이 살아 있게 한다.
//
// 만료가 없는 쿠키(세션 쿠키)는 크로미움이 브라우저를 닫을 때 버린다. 무신사의 로그인 토큰
// (app_atk·app_rtk)이 이 종류라, 앱을 다시 켤 때마다 프로필 탭이 "상단은 로그아웃(=로그인),
// 구매 버튼은 회원 전용" 인 반쪽 상태로 시작했다(실기). 헤더용 쿠키는 만료가 있어 남고
// 토큰만 사라져서다. 크롬의 "이전 세션 이어서" 와 같은 동작을 파티션에 준다:
// 세션 쿠키가 생기면 같은 값에 만료만 얹어 다시 저장한다.
//
// 값은 읽어 그대로 되쓰기만 한다 — 로그·IPC·렌더러 어디에도 나가지 않는다.

import type { Cookie, CookiesSetDetails, Session } from 'electron'

/** 세션 쿠키에 얹는 수명. 사이트가 서버에서 만료시키면 그쪽이 우선한다 */
export const SESSION_COOKIE_KEEP_DAYS = 14

/** 이 모듈이 세션에서 쓰는 부분만(테스트에서 대역으로 갈아 끼운다) */
export interface CookieJarLike {
  on(
    event: 'changed',
    listener: (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void
  ): unknown
  set(details: CookiesSetDetails): Promise<void>
}

/** 쿠키가 온 도메인·경로로 되돌아갈 URL(set 은 url 을 요구한다) */
export function cookieUrl(cookie: Pick<Cookie, 'domain' | 'path' | 'secure'>): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

/** 세션 쿠키 → 만료를 얹은 저장 요청(순수 함수). 세션 쿠키가 아니면 null */
export function persistedCookie(
  cookie: Cookie,
  now: number = Date.now(),
  keepDays: number = SESSION_COOKIE_KEEP_DAYS
): CookiesSetDetails | null {
  if (!cookie.session) return null
  if (!cookie.domain) return null
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    expirationDate: Math.floor(now / 1000) + keepDays * 24 * 60 * 60
  }
}

/**
 * 파티션의 세션 쿠키를 만료 있는 쿠키로 바꿔 저장한다.
 * 다시 저장한 쿠키는 세션 쿠키가 아니므로 'changed' 가 다시 와도 건너뛴다(무한 반복 없음)
 */
export function keepSessionCookies(
  cookies: CookieJarLike,
  deps: { now?: () => number; keepDays?: number; onError?: (name: string) => void } = {}
): void {
  cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed) return
    const details = persistedCookie(cookie, (deps.now ?? Date.now)(), deps.keepDays)
    if (!details) return
    void cookies.set(details).catch(() => deps.onError?.(cookie.name))
  })
}

/** 앱의 파티션 세션에 붙인다 */
export function installSessionCookieKeeper(ses: Session): void {
  keepSessionCookies(ses.cookies, {
    // 값은 남기지 않는다 — 어느 쿠키인지 이름만
    onError: (name) => console.warn(`세션 쿠키 유지 실패: ${name}`)
  })
}
