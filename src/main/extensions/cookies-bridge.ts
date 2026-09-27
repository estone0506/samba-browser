// 확장 서비스워커의 chrome.cookies 호출을 세션 쿠키 저장소로 처리한다(preload/extension-sw.ts 짝).
//
// 받아 주는 조건: 호출한 서비스워커가 확장(chrome-extension://<id>/)이고, 그 확장의 manifest 가
// cookies 권한을 선언했을 때만. 그 밖의 서비스워커(일반 사이트)는 거절한다.
import type { Cookie, CookiesSetDetails, Session } from 'electron'
import { runTabsOp } from './tabs-bridge'

export const EXT_COOKIES_CHANNEL = 'samba-ext-cookies'
// 탭·창 보충(preload/extension-sw.ts 의 tabs.create·windows 등)
export const EXT_TABS_CHANNEL = 'samba-ext-tabs'
// 쿠키 변경 알림(chrome.cookies.onChanged) — 메인 → 확장 서비스워커
export const EXT_COOKIE_CHANGED_CHANNEL = 'samba-ext-cookie-changed'

/** 크롬 확장 API 의 Cookie 모양 */
export interface ChromeCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  session: boolean
  expirationDate?: number
  storeId: string
}

/** Electron 쿠키 → 크롬 확장 쿠키(순수 함수) */
export function toChromeCookie(c: Cookie): ChromeCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    hostOnly: c.hostOnly ?? false,
    path: c.path ?? '/',
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite === 'unspecified' ? 'unspecified' : (c.sameSite ?? 'unspecified'),
    session: c.session ?? true,
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
    storeId: '0'
  }
}

/** chrome.cookies.onChanged 로 보낼 값(순수 함수). Electron 원인 이름을 크롬 이름으로 바꾼다 */
export function toChromeCookieChange(
  cookie: Cookie,
  cause: string,
  removed: boolean
): { cookie: ChromeCookie; cause: string; removed: boolean } {
  return { cookie: toChromeCookie(cookie), cause: cause.replace(/-/g, '_'), removed }
}

type Details = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** 쿠키 동작 하나(순수에 가깝게 — 세션 쿠키 저장소만 쓴다) */
export async function runCookieOp(ses: Session, op: string, raw: unknown): Promise<unknown> {
  const d: Details = typeof raw === 'object' && raw !== null ? (raw as Details) : {}
  const url = str(d.url)
  const name = str(d.name)
  switch (op) {
    case 'get': {
      if (!url || !name) return null
      const list = await ses.cookies.get({ url, name })
      return list.length ? toChromeCookie(list[0]) : null
    }
    case 'getAll': {
      const filter: Electron.CookiesGetFilter = {}
      if (url) filter.url = url
      if (name) filter.name = name
      if (str(d.domain)) filter.domain = str(d.domain)
      if (str(d.path)) filter.path = str(d.path)
      if (typeof d.secure === 'boolean') filter.secure = d.secure
      if (typeof d.session === 'boolean') filter.session = d.session
      return (await ses.cookies.get(filter)).map(toChromeCookie)
    }
    case 'set': {
      if (!url) return null
      const set: CookiesSetDetails = { url }
      if (name !== undefined) set.name = name
      if (typeof d.value === 'string') set.value = d.value
      if (str(d.domain)) set.domain = str(d.domain)
      if (str(d.path)) set.path = str(d.path)
      if (typeof d.secure === 'boolean') set.secure = d.secure
      if (typeof d.httpOnly === 'boolean') set.httpOnly = d.httpOnly
      if (typeof d.expirationDate === 'number') set.expirationDate = d.expirationDate
      if (d.sameSite === 'no_restriction' || d.sameSite === 'lax' || d.sameSite === 'strict' || d.sameSite === 'unspecified') {
        set.sameSite = d.sameSite
      }
      await ses.cookies.set(set)
      const list = name ? await ses.cookies.get({ url, name }) : []
      return list.length ? toChromeCookie(list[0]) : null
    }
    case 'remove': {
      if (!url || !name) return null
      await ses.cookies.remove(url, name)
      return { url, name, storeId: '0' }
    }
    default:
      return null
  }
}

/** 확장 id 를 서비스워커 scope 에서 뽑는다. 확장이 아니면 null */
export function extensionIdOfScope(scope: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope)
  return m ? m[1] : null
}

/** 확장 manifest 가 cookies 권한을 선언했는가 */
export function declaresCookies(manifest: unknown): boolean {
  const perms = (manifest as { permissions?: unknown } | null)?.permissions
  return Array.isArray(perms) && perms.includes('cookies')
}

// 이미 보충을 건 세션(같은 세션에 preload 를 두 번 등록하지 않는다)
const enabledSessions = new WeakSet<object>()

/**
 * 세션에 확장 서비스워커 보충(preload + chrome.cookies 처리기)을 한 번만 건다.
 * 확장을 로드하기 **전에** 불러야 한다 — 이미 뜬 서비스워커에는 preload 가 붙지 않는다(실기: 기본 세션에 없어 그대로 죽었다)
 */
export function enableExtensionServiceWorkerSupport(ses: Session, preloadPath: string): void {
  if (enabledSessions.has(ses)) return
  enabledSessions.add(ses)
  ses.registerPreloadScript({ type: 'service-worker', filePath: preloadPath })
  installExtensionCookiesBridge(ses)
}

// 이미 처리기를 건 서비스워커(같은 워커에 두 번 걸면 Electron 이 오류를 낸다)
const wired = new WeakSet<object>()
// 세션별 쿠키 권한 확장 서비스워커 — 쿠키가 바뀌면 이들에게 알린다
const cookieWorkers = new WeakMap<Session, Set<{ send: (channel: string, ...args: unknown[]) => void }>>()

/** 세션의 확장 서비스워커가 뜰 때마다 chrome.cookies 처리기를 건다(세션당 1회 호출) */
export function installExtensionCookiesBridge(ses: Session): void {
  // 샵백 확장은 로그인 토큰 쿠키가 생기는 것을 onChanged 로 보고 로그인을 알아챈다 — 알림이 없으면
  // 프로필에서 로그인해도 확장은 로그아웃 상태로 남았다(실기 2026-09-27)
  const workers = new Set<{ send: (channel: string, ...args: unknown[]) => void }>()
  cookieWorkers.set(ses, workers)
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    if (workers.size === 0) return
    const payload = toChromeCookieChange(cookie, cause, removed)
    for (const w of [...workers]) {
      try {
        w.send(EXT_COOKIE_CHANGED_CHANNEL, payload)
      } catch {
        workers.delete(w) // 멈춘 워커
      }
    }
  })
  ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || wired.has(worker)) return
    const id = extensionIdOfScope(worker.scope)
    if (!id) return
    wired.add(worker)
    const ext0 = ses.extensions?.getExtension?.(id) ?? ses.getExtension?.(id)
    if (ext0 && declaresCookies(ext0.manifest)) workers.add(worker)
    worker.ipc.handle(EXT_COOKIES_CHANNEL, async (_e, op: unknown, details: unknown) => {
      const ext = ses.extensions?.getExtension?.(id) ?? ses.getExtension?.(id)
      if (!ext || !declaresCookies(ext.manifest)) return null
      try {
        return await runCookieOp(ses, String(op), details)
      } catch (e: unknown) {
        console.warn('확장 쿠키 처리 실패', id, e instanceof Error ? e.message : String(e))
        return null
      }
    })
    // 탭·창은 확장이면 권한과 무관하게 받는다(크롬도 tabs.create 는 권한 없이 된다)
    worker.ipc.handle(EXT_TABS_CHANNEL, (_e, op: unknown, details: unknown) => {
      try {
        return runTabsOp(String(op), details, ses, id)
      } catch (e: unknown) {
        console.warn('확장 탭 처리 실패', id, e instanceof Error ? e.message : String(e))
        return null
      }
    })
  })
}
