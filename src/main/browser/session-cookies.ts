// 세션 쿠키 유지 — 앱을 닫아도 로그인이 살아 있게 한다.
//
// 만료가 없는 쿠키(세션 쿠키)는 크로미움이 브라우저를 닫을 때 버린다. 무신사의 로그인 토큰
// (app_atk·app_rtk)이 이 종류라, 앱을 다시 켤 때마다 프로필 탭이 "상단은 로그아웃(=로그인),
// 구매 버튼은 회원 전용" 인 반쪽 상태로 시작했다(실기). 헤더용 쿠키는 만료가 있어 남고
// 토큰만 사라져서다. 크롬의 "이전 세션 이어서" 와 같은 동작을 파티션에 준다:
// 세션 쿠키가 생기면 같은 값에 만료만 얹어 다시 저장한다.
//
// 값은 읽어 그대로 되쓰기만 한다 — 로그·IPC·렌더러 어디에도 나가지 않는다.
//
// host-only 쿠키(도메인 속성 없이 받은 쿠키)는 domain 을 넘기지 않고 되써야 한다. domain 을 넘기면
// 크로미움이 '.호스트' 도메인 쿠키를 **따로** 만들어 같은 이름이 두 벌이 된다. 사이트가 1회용 토큰
// 쿠키를 지워도 복제본이 남아 옛 토큰을 계속 보내고, 슈마커는 그 요청마다 history.back() 을 돌려줘
// 검색·클릭·구매하기가 전부 이전 페이지로 튕겼다(실기 2026-09-26, 웨일에는 복제본 없음).

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
  // host-only 세션 쿠키는 건드리지 않는다. 같은 쿠키를 덮어쓰면 사이트가 곧바로 바꾼 새 값을 비동기 되쓰기가
  // 옛 값으로 되돌린다 — 무신사머니 결제창이 "로그인 세션을 찾을 수 없습니다"로 튕겼다(실기 2026-09-26).
  // 로그인 유지가 필요한 토큰(무신사 app_atk 등)은 도메인 쿠키라 그대로 남긴다
  if (cookie.hostOnly) return null
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

/** 복제본 정리에 쓰는 쿠키 저장소 부분(테스트 대역용) */
export interface CookieStoreLike {
  get(filter: Record<string, never>): Promise<Cookie[]>
  set(details: CookiesSetDetails): Promise<void>
  remove(url: string, name: string): Promise<void>
}

/**
 * 예전 코드가 만든 '.호스트' 복제본인가(순수 함수). 도메인이 '.www.' 로 시작할 때만 복제본으로 본다
 * (사이트가 Domain=www.… 를 주는 일은 사실상 없다). 쌍둥이가 있으면 쌍둥이 값을, 없으면 복제본 값을 host-only 로 옮긴다.
 *
 * '같은 값의 host-only 쌍둥이가 있으면 복제본'이라는 규칙은 뺐다 — 사이트가 원래 Domain=.naver.com 으로 준
 * 로그인 쿠키(NID_AUT 등)까지 host-only 로 바꿔 nid·pay 하위 도메인에서 로그인이 풀렸다(실기 2026-09-26)
 */
export function duplicatedHostCookie(
  c: Cookie,
  all: Cookie[]
): { twin: Cookie | null } | null {
  if (c.hostOnly || c.session || !c.domain?.startsWith('.')) return null
  const host = c.domain.slice(1)
  const twin =
    all.find((t) => t.hostOnly && t.domain === host && t.name === c.name && t.path === c.path) ?? null
  if (host.startsWith('www.')) return { twin }
  return null
}

/**
 * 예전 코드가 만든 복제본을 host-only 영구 쿠키 한 벌로 합친다.
 * remove(url, name) 은 그 주소에 붙는 같은 이름 쿠키를 둘 다 지우므로, 지운 뒤 한 벌만 다시 쓴다
 */
export async function mergeDuplicatedHostCookies(
  store: CookieStoreLike,
  deps: { now?: () => number; keepDays?: number } = {}
): Promise<number> {
  const all = await store.get({})
  const now = (deps.now ?? Date.now)()
  const keep = deps.keepDays ?? SESSION_COOKIE_KEEP_DAYS
  let merged = 0
  for (const c of all) {
    const dup = duplicatedHostCookie(c, all)
    if (!dup) continue
    const src = dup.twin ?? c
    const url = cookieUrl({ domain: c.domain, path: c.path, secure: c.secure })
    await store.remove(url, c.name)
    await store.set({
      url,
      name: c.name,
      value: src.value,
      path: c.path ?? '/',
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      expirationDate: c.expirationDate ?? Math.floor(now / 1000) + keep * 24 * 60 * 60
    })
    merged++
  }
  return merged
}

/** 앱의 파티션 세션에 붙인다 */
export function installSessionCookieKeeper(ses: Session): void {
  // 예전 코드가 남긴 복제본부터 정리(실패해도 앱은 계속 — 이름·값은 남기지 않는다)
  void mergeDuplicatedHostCookies(ses.cookies as unknown as CookieStoreLike)
    .then((n) => {
      if (n) console.log(`세션 쿠키 복제본 ${n}개 정리`)
    })
    .catch((e: unknown) => console.warn('세션 쿠키 복제본 정리 실패', e instanceof Error ? e.message : String(e)))
  keepSessionCookies(ses.cookies, {
    // 값은 남기지 않는다 — 어느 쿠키인지 이름만
    onError: (name) => console.warn(`세션 쿠키 유지 실패: ${name}`)
  })
}
