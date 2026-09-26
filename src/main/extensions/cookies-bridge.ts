// 확장 서비스워커의 chrome.cookies 호출을 세션 쿠키 저장소로 처리한다(preload/extension-sw.ts 짝).
//
// 받아 주는 조건: 호출한 서비스워커가 확장(chrome-extension://<id>/)이고, 그 확장의 manifest 가
// cookies 권한을 선언했을 때만. 그 밖의 서비스워커(일반 사이트)는 거절한다.
import type { Cookie, CookiesSetDetails, Session } from 'electron'

export const EXT_COOKIES_CHANNEL = 'samba-ext-cookies'

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

// 이미 처리기를 건 서비스워커(같은 워커에 두 번 걸면 Electron 이 오류를 낸다)
const wired = new WeakSet<object>()

/** 세션의 확장 서비스워커가 뜰 때마다 chrome.cookies 처리기를 건다(세션당 1회 호출) */
export function installExtensionCookiesBridge(ses: Session): void {
  ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || wired.has(worker)) return
    const id = extensionIdOfScope(worker.scope)
    if (!id) return
    wired.add(worker)
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
  })
}
