// 확장 서비스워커의 chrome.cookies 호출을 세션 쿠키 저장소로 처리한다(preload/extension-sw.ts 짝).
//
// 받아 주는 조건: 호출한 서비스워커가 확장(chrome-extension://<id>/)이고, 그 확장의 manifest 가
// cookies 권한을 선언했을 때만. 그 밖의 서비스워커(일반 사이트)는 거절한다.
import { app, webContents } from 'electron'
import type { Cookie, CookiesSetDetails, Session, WebContents } from 'electron'
import { isActiveTabId, runTabsOp } from './tabs-bridge'

export const EXT_COOKIES_CHANNEL = 'samba-ext-cookies'
// 탭·창 보충(preload/extension-sw.ts 의 tabs.create·windows 등)
export const EXT_TABS_CHANNEL = 'samba-ext-tabs'
// 쿠키 변경 알림(chrome.cookies.onChanged) — 메인 → 확장 서비스워커
export const EXT_COOKIE_CHANGED_CHANNEL = 'samba-ext-cookie-changed'
// 최상위 프레임 이동 알림(chrome.webNavigation.onCommitted·onCompleted) — 메인 → 확장 서비스워커
export const EXT_NAV_CHANNEL = 'samba-ext-nav'
// 확장이 툴바 아이콘을 바꿀 때(chrome.action.setIcon) — 확장 서비스워커 → 메인
export const EXT_ACTION_CHANNEL = 'samba-ext-action'

export type ExtensionActionListener = (extensionId: string, op: string, details: unknown) => void
let actionListener: ExtensionActionListener | null = null
/** 확장의 chrome.action 호출(setIcon 등)을 받을 곳을 건다 — 툴바가 아이콘을 바꿔 그린다 */
export function setExtensionActionListener(fn: ExtensionActionListener | null): void {
  actionListener = fn
}

/** setIcon 의 path 인자에서 그릴 파일 하나를 고른다(순수 함수) — 문자열이거나 {크기: 경로} 표 */
export function pickActionIconPath(raw: unknown): string | null {
  if (typeof raw === 'string' && raw) return raw
  if (typeof raw !== 'object' || raw === null) return null
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' && v
  )
  if (entries.length === 0) return null
  entries.sort((a, b) => Number(b[0]) - Number(a[0]))
  return entries[0][1] as string
}
// 확장 서비스워커가 이동·탭 리스너를 단 뒤 보내는 준비 신호(preload/extension-sw.ts)
export const EXT_READY_CHANNEL = 'samba-ext-ready'
// 워커 오류 보고(error·unhandledrejection·알람 리스너 예외) — preload/extension-sw 가 보낸다
export const EXT_ERROR_CHANNEL = 'samba-ext-error'
// 준비 신호가 없을 때 이벤트를 보내기 전 최대 대기(큰 확장은 초기화가 몇 초 걸린다)
export const SW_READY_TIMEOUT_MS = 5000

/** webNavigation 이벤트 값(순수 함수) — 최상위 프레임만 보낸다 */
export function toNavDetails(
  tabId: number,
  url: string,
  now: number,
  active = false
): {
  tabId: number
  url: string
  frameId: number
  parentFrameId: number
  processId: number
  timeStamp: number
  transitionType: string
  transitionQualifiers: string[]
  active: boolean
} {
  return {
    tabId,
    url,
    frameId: 0,
    parentFrameId: -1,
    processId: 0,
    timeStamp: now,
    transitionType: 'link',
    transitionQualifiers: [],
    active
  }
}

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
      if (
        d.sameSite === 'no_restriction' ||
        d.sameSite === 'lax' ||
        d.sameSite === 'strict' ||
        d.sameSite === 'unspecified'
      ) {
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

/**
 * 세션의 서비스워커 확장을 미리 깨운다(준비 신호까지 기다린다).
 *
 * 왜: 앱 시작 뒤 첫 이동에서 샵백 활성화 페이지가 아직 초기화 중인 백그라운드에 묻고 빈 답을 받아
 * 빈 화면으로 넘어갔다(2026-09-27). 프로필 세션이 생기거나 확장이 붙을 때 먼저 깨워 둔다
 */
export async function warmExtensionWorkers(ses: Session): Promise<void> {
  const exts = ses.extensions?.getAllExtensions?.() ?? []
  for (const ext of exts) {
    const manifest = ext.manifest as { background?: { service_worker?: string } }
    if (!manifest?.background?.service_worker) continue
    try {
      const w = await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}/`)
      await readyOf(w)
    } catch (e: unknown) {
      console.warn(
        '확장 서비스워커 깨우기 실패',
        ext.id,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
}

// 이미 처리기를 건 서비스워커(같은 워커에 두 번 걸면 Electron 이 오류를 낸다)
const wired = new WeakSet<object>()
// 세션별 탭 이벤트 전송기 — 탭 활성화(tabs.onActivated)를 탭 관리자 쪽에서 밀어 넣는다
const tabEventSenders = new WeakMap<Session, (kind: string, details: unknown) => void>()
/** 확장 서비스워커에 탭 이벤트(activated 등)를 보낸다. 세션에 다리가 없으면 무시 */
export function sendExtensionTabEvent(ses: Session, kind: string, details: unknown): void {
  tabEventSenders.get(ses)?.(kind, details)
}
// 워커별 준비 신호 — 확장이 이동·탭 리스너를 단 뒤 보낸다(샵백처럼 초기화가 느린 확장은 그 전에 온 이벤트를 놓친다)
const readyPromises = new WeakMap<object, Promise<void>>()
const readyResolvers = new WeakMap<object, () => void>()
function readyOf(worker: object): Promise<void> {
  let p = readyPromises.get(worker)
  if (!p) {
    p = new Promise<void>((resolve) => {
      readyResolvers.set(worker, resolve)
      setTimeout(resolve, SW_READY_TIMEOUT_MS)
    })
    readyPromises.set(worker, p)
  }
  return p
}
// 세션별 쿠키 권한 확장 서비스워커 — 쿠키가 바뀌면 이들에게 알린다
const cookieWorkers = new WeakMap<
  Session,
  Set<{ send: (channel: string, ...args: unknown[]) => void }>
>()

/** 세션의 확장 서비스워커가 뜰 때마다 chrome.cookies 처리기를 건다(세션당 1회 호출) */
export function installExtensionCookiesBridge(ses: Session): void {
  // 샵백 확장은 로그인 토큰 쿠키가 생기는 것을 onChanged 로 보고 로그인을 알아챈다 — 알림이 없으면
  // 프로필에서 로그인해도 확장은 로그아웃 상태로 남았다(실기 2026-09-27)
  const workers = new Set<{ send: (channel: string, ...args: unknown[]) => void }>()
  cookieWorkers.set(ses, workers)
  // 확장 서비스워커 전부(권한 무관) — 최상위 프레임 이동을 알린다. 샵백은 샵백 페이지 이동(onCommitted)에서
  // sbet 쿠키를 읽어 로그인을 맞춘다 — 이벤트가 없으면 로그인해도 확장이 모른다(실기 2026-09-27)
  // 크롬은 이벤트가 오면 잠든 백그라운드를 깨워 전달한다 — 여기서도 서비스워커 확장을 깨운 뒤 보낸다.
  // 막 깨운 워커는 리스너를 다는 데 시간이 걸리므로 잠깐 기다린다(실기 2026-09-27 샵백: 잠든 채 이벤트를 놓쳤다)
  // 이동 알림은 일어난 순서대로 보낸다 — 깨우기·준비 대기가 비동기라 순서가 섞이면 확장이 탭 주소를
  // 거꾸로 기억한다(실기 2026-09-27: 활성화 페이지 → 롯데온 순서가 뒤집혀 아이콘이 빨간색으로 남음)
  let navChain: Promise<void> = Promise.resolve()
  const enqueue = (kind: string, details: unknown): void => {
    navChain = navChain.then(() => deliverNav(kind, details)).catch(() => {})
  }
  tabEventSenders.set(ses, enqueue)
  const sendNav = (
    kind: 'committed' | 'domloaded' | 'completed',
    wc: WebContents,
    url: string
  ): void => {
    if (!/^https?:/.test(url)) return
    const active = isActiveTabId(wc.id)
    enqueue(kind, toNavDetails(wc.id, url, Date.now(), active))
    // 보이는 탭이 다 읽히면 활성화 알림도 한 번 더 — 확장이 아이콘·알림을 다시 판정한다(샵백 CHECK_ICON)
    if (kind === 'completed' && active) enqueue('activated', { tabId: wc.id, windowId: 0 })
  }
  const deliverNav = async (kind: string, details: unknown): Promise<void> => {
    const exts = ses.extensions?.getAllExtensions?.() ?? []
    for (const ext of exts) {
      const manifest = ext.manifest as { background?: { service_worker?: string } }
      if (!manifest?.background?.service_worker) continue
      try {
        const w = await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}/`)
        await readyOf(w)
        w.send(EXT_NAV_CHANNEL, kind, details)
        // 전달 기록(주소만) — 확장이 탭 주소를 못 따라올 때 어디까지 갔는지 본다(2026-09-27)
        const d = details as { tabId?: number; url?: string }
        console.log(
          '[ext-nav]',
          ext.id.slice(0, 8),
          kind,
          d.tabId,
          String(d.url ?? '').slice(0, 80)
        )
      } catch (e: unknown) {
        console.warn('확장 이동 알림 실패', ext.id, e instanceof Error ? e.message : String(e))
      }
    }
  }
  const watch = (wc: WebContents): void => {
    if (wc.session !== ses) return
    wc.on('did-navigate', (_ev, url) => sendNav('committed', wc, url))
    // 샵백은 onDOMContentLoaded 에서 API 해시·매장 목록을 받아 온다 — 없으면 매장 목록이 비어 아이콘이 안 바뀐다(2026-09-27)
    wc.on('dom-ready', () => sendNav('domloaded', wc, wc.getURL()))
    wc.on('did-finish-load', () => sendNav('completed', wc, wc.getURL()))
  }
  for (const wc of webContents.getAllWebContents()) watch(wc)
  app.on('web-contents-created', (_e, wc) => watch(wc))
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
  // 워커 콘솔(경고·오류만) — 확장이 어디서 막히는지 앱 로그로 본다
  ses.serviceWorkers.on('console-message', (_e, d) => {
    if (d.level < 2) return
    console.log(
      '[ext-console]',
      d.versionId,
      d.level,
      String(d.message).slice(0, 400),
      d.source,
      d.lineNumber
    )
  })
  ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || wired.has(worker)) return
    const id = extensionIdOfScope(worker.scope)
    if (!id) return
    wired.add(worker)
    void readyOf(worker)
    worker.ipc.on(EXT_READY_CHANNEL, () => {
      console.log('[ext-ready]', id.slice(0, 8))
      readyResolvers.get(worker)?.()
    })
    worker.ipc.on(EXT_ERROR_CHANNEL, (_e, kind: unknown, message: unknown) => {
      console.log('[ext-error]', id.slice(0, 8), String(kind), String(message).slice(0, 600))
    })
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
    // 툴바 아이콘 변경(샵백: 활성화되면 초록 아이콘) — 앱은 매니페스트 기본 아이콘만 그렸다(2026-09-27)
    worker.ipc.on(EXT_ACTION_CHANNEL, (_e, op: unknown, details: unknown) => {
      try {
        actionListener?.(id, String(op), details)
      } catch (e: unknown) {
        console.warn('확장 액션 처리 실패', id, e instanceof Error ? e.message : String(e))
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
