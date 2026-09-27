// 확장 서비스워커(백그라운드) 보충 — Electron 에 없는 chrome.cookies 를 만든다.
//
// 왜: 삼바웨이브·ADPICK 같은 확장이 chrome.cookies 를 부르면 Electron 에는 그 API 가 없어
// "Cannot read properties of undefined (reading 'get')" 로 백그라운드 처리가 죽었다(실기 2026-09-26).
// 실제 쿠키 읽기·쓰기는 메인 프로세스(extensions/cookies-bridge)가 확장의 세션 쿠키 저장소로 하고,
// 여기서는 호출만 넘긴다. 메인은 manifest 에 cookies 권한이 있는 확장만 받아 준다.
import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL = 'samba-ext-cookies'

type CookieOp = 'get' | 'getAll' | 'set' | 'remove'

const invoke = (op: CookieOp, details: unknown): Promise<unknown> =>
  ipcRenderer.invoke(CHANNEL, op, details)

// 쿠키 변경 알림 — 메인이 세션 쿠키가 바뀔 때마다 보낸다(chrome.cookies.onChanged)
const CHANGED_CHANNEL = 'samba-ext-cookie-changed'
const subscribe = (fn: (change: unknown) => void): void => {
  ipcRenderer.on(CHANGED_CHANNEL, (_e, change: unknown) => fn(change))
}

// 탭·창 — 메인(extensions/tabs-bridge)이 앱 탭으로 처리한다
const TABS_CHANNEL = 'samba-ext-tabs'
const invokeTabs = (op: string, details: unknown): Promise<unknown> =>
  ipcRenderer.invoke(TABS_CHANNEL, op, details)

// 툴바 아이콘 변경 알림(chrome.action.setIcon) — 메인이 툴바를 다시 그린다
const ACTION_CHANNEL = 'samba-ext-action'
const notifyAction = (op: string, details: unknown): void => {
  ipcRenderer.send(ACTION_CHANNEL, op, details)
}

// 최상위 프레임 이동 알림(webNavigation.onCommitted·onCompleted) — 메인이 보낸다
const NAV_CHANNEL = 'samba-ext-nav'
// 확장이 이동·탭 리스너를 달았다 — 메인은 이 신호 뒤에 이벤트를 보낸다(한 번만)
const READY_CHANNEL = 'samba-ext-ready'
let readySent = false
const notifyReady = (): void => {
  if (readySent) return
  readySent = true
  ipcRenderer.send(READY_CHANNEL)
}
const subscribeNav = (fn: (kind: string, details: unknown) => void): void => {
  ipcRenderer.on(NAV_CHANNEL, (_e, kind: string, details: unknown) => fn(kind, details))
}

contextBridge.executeInMainWorld({
  func: (
    call: (op: string, details: unknown) => Promise<unknown>,
    listen: (fn: (change: unknown) => void) => void
  ): void => {
    const g = globalThis as unknown as { chrome?: Record<string, unknown> }
    if (!g.chrome || g.chrome.cookies) return
    const listeners: Array<(change: unknown) => void> = []
    listen((change) => {
      for (const l of [...listeners]) {
        try {
          l(change)
        } catch {
          // 확장 리스너 오류가 다른 리스너를 막지 않게
        }
      }
    })
    // 콜백을 주면 콜백으로, 안 주면 Promise 로 — 크롬 확장 API 와 같은 모양
    const wrap =
      (op: string) =>
      (details: unknown, cb?: (value: unknown) => void): Promise<unknown> | undefined => {
        const p = call(op, details)
        if (typeof cb !== 'function') return p
        p.then(
          (v) => cb(v),
          () => cb(undefined)
        )
        return undefined
      }
    const stores = [{ id: '0', tabIds: [] as number[] }]
    g.chrome.cookies = {
      get: wrap('get'),
      getAll: wrap('getAll'),
      set: wrap('set'),
      remove: wrap('remove'),
      getAllCookieStores: (cb?: (v: unknown) => void) =>
        typeof cb === 'function' ? cb(stores) : Promise.resolve(stores),
      onChanged: {
        addListener: (fn: (change: unknown) => void) => {
          if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn)
        },
        removeListener: (fn: (change: unknown) => void) => {
          const i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
        },
        hasListener: (fn: (change: unknown) => void) => listeners.includes(fn)
      }
    }
  },
  args: [invoke, subscribe]
})

// Electron 서비스워커에 없는 tabs.create·remove, windows, notifications, identity 를 보충한다.
// 삼바웨이브는 탭을 열고 닫는 일이 많고(tabs.create 32곳·remove 42곳), 애드픽은 설치 안내 탭을 연다
contextBridge.executeInMainWorld({
  func: (
    call: (op: string, details: unknown) => Promise<unknown>,
    listenNav: (fn: (kind: string, details: unknown) => void) => void,
    notify: (op: string, details: unknown) => void,
    ready: () => void
  ): void => {
    type Cb = (v: unknown) => void
    const g = globalThis as unknown as { chrome?: Record<string, unknown> }
    const c = g.chrome
    if (!c) return
    const reply = (p: Promise<unknown>, cb: unknown): Promise<unknown> | undefined => {
      if (typeof cb !== 'function') return p
      p.then(
        (v) => (cb as Cb)(v),
        () => (cb as Cb)(undefined)
      )
      return undefined
    }
    const lastFn = (a: unknown[]): unknown => (typeof a[a.length - 1] === 'function' ? a[a.length - 1] : undefined)
    const noEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
    const set = (o: Record<string, unknown>, k: string, v: unknown): void => {
      try {
        o[k] = v
      } catch {
        Object.defineProperty(o, k, { value: v, configurable: true })
      }
    }
    const tabs = (c.tabs ?? {}) as Record<string, unknown>
    if (typeof tabs.create !== 'function') set(tabs, 'create', (props: unknown, cb?: unknown) => reply(call('create', props ?? {}), cb))
    if (typeof tabs.remove !== 'function') set(tabs, 'remove', (ids: unknown, cb?: unknown) => reply(call('remove', { tabIds: ids }), cb))
    // tabs.update — Electron 기본 구현은 tabId 없는 호출(지금 보고 있는 탭 이동)을 처리하지 못한다.
    // 샵백은 활성화 뒤 tabs.update({url}) 로 상점으로 넘어가는데 여기서 멈췄다(2026-09-27). 항상 앱 탭 브리지로 보낸다
    set(tabs, 'update', (...a: unknown[]) => {
      const hasId = typeof a[0] === 'number'
      const tabId = hasId ? (a[0] as number) : undefined
      const props = (hasId ? a[1] : a[0]) ?? {}
      return reply(call('update', { tabId, props }), lastFn(a))
    })
    if (!c.tabs) set(c, 'tabs', tabs)
    if (!c.windows) {
      const win = (info: unknown, cb: unknown) => reply(call('windowGet', info ?? {}), cb)
      set(c, 'windows', {
        WINDOW_ID_NONE: -1,
        WINDOW_ID_CURRENT: -2,
        get: (...a: unknown[]) => win(typeof a[1] === 'object' ? a[1] : {}, lastFn(a)),
        getCurrent: (...a: unknown[]) => win(typeof a[0] === 'object' ? a[0] : {}, lastFn(a)),
        getLastFocused: (...a: unknown[]) => win(typeof a[0] === 'object' ? a[0] : {}, lastFn(a)),
        getAll: (...a: unknown[]) => reply(call('windowGet', typeof a[0] === 'object' ? a[0] : {}).then((w) => [w]), lastFn(a)),
        create: (d: unknown, cb?: unknown) => {
          const url = (d as { url?: unknown } | undefined)?.url
          const first = Array.isArray(url) ? url[0] : url
          return reply(call('create', { url: typeof first === 'string' ? first : undefined }).then(() => call('windowGet', {})), cb)
        },
        update: (_id: unknown, _info: unknown, cb?: unknown) => win({}, cb),
        remove: (_id: unknown, cb?: unknown) => reply(Promise.resolve(undefined), cb),
        onCreated: noEvent,
        onRemoved: noEvent,
        onFocusChanged: noEvent
      })
    }
    // 알림은 띄우지 않고 받기만 한다(앱에 확장 알림 표시가 없다) — 부르는 쪽이 죽지 않게
    if (!c.notifications) {
      set(c, 'notifications', {
        create: (...a: unknown[]) => reply(Promise.resolve(typeof a[0] === 'string' ? a[0] : 'samba-note'), lastFn(a)),
        clear: (_id: unknown, cb?: unknown) => reply(Promise.resolve(true), cb),
        onClicked: noEvent,
        onClosed: noEvent,
        onButtonClicked: noEvent
      })
    }
    // webNavigation — Electron 에 없다. 샵백 백그라운드가 시작하자마자 onBeforeNavigate 에 붙다가 죽었다(2026-09-26).
    // 이벤트는 아직 보내 주지 않는다(등록만 받는다). 프레임 조회는 최상위 프레임 하나로 답한다
    // 최상위 프레임 이동만 보낸다(샵백은 onCommitted 로 로그인 쿠키를 맞춘다 — 2026-09-27)
    const navListeners: Record<string, Array<(d: unknown) => void>> = { committed: [], domloaded: [], completed: [] }
    // tabs.onActivated — 탭이 보이는 탭이 될 때(앱 탭 관리자가 알린다)
    const activatedListeners: Array<(info: unknown) => void> = []
    set(tabs, 'onActivated', {
      addListener: (fn: (info: unknown) => void) => {
        if (typeof fn === 'function' && !activatedListeners.includes(fn)) activatedListeners.push(fn)
        ready()
      },
      removeListener: (fn: (info: unknown) => void) => {
        const i = activatedListeners.indexOf(fn)
        if (i >= 0) activatedListeners.splice(i, 1)
      },
      hasListener: (fn: (info: unknown) => void) => activatedListeners.includes(fn)
    })
    listenNav((kind, details) => {
      if (kind === 'activated') {
        for (const l of [...activatedListeners]) {
          try {
            l(details)
          } catch {
            // 리스너 오류 무시
          }
        }
        return
      }
      if (kind !== 'domloaded') fireUpdated(kind, details)
      for (const l of [...(navListeners[kind] ?? [])]) {
        try {
          l(details)
        } catch {
          // 확장 리스너 오류가 다른 리스너를 막지 않게
        }
      }
    })
    // tabs.onUpdated — Electron 은 이 이벤트를 우리 탭에 대해 보내지 않는다. 최상위 이동 알림으로 대신 만든다
    // (샵백은 onUpdated 로 롯데온 탭을 알아채 알림을 띄우고 활성 상태를 기록한다 — 2026-09-27)
    const updatedListeners: Array<(tabId: number, info: unknown, tab: unknown) => void> = []
    // 탭 조회 없이 알림 값만으로 즉시 발생시킨다 — 비동기로 늦게 보내면 webNavigation 알림과 순서가 뒤집혀
    // 확장이 탭 주소를 거꾸로 기억한다(실기 2026-09-27 샵백: 롯데온 committed 뒤에 alink onUpdated 가 도착)
    const fireUpdated = (kind: string, details: unknown): void => {
      const d = (details ?? {}) as { tabId?: number; url?: string; active?: boolean }
      if (typeof d.tabId !== 'number') return
      const status = kind === 'committed' ? 'loading' : 'complete'
      const info = kind === 'committed' ? { status, url: d.url } : { status }
      const t = { id: d.tabId, url: d.url, status, active: d.active === true, windowId: 0, index: 0, highlighted: d.active === true, incognito: false, pinned: false, selected: d.active === true, title: '' }
      for (const l of [...updatedListeners]) {
        try {
          l(d.tabId, info, t)
        } catch {
          // 리스너 오류 무시
        }
      }
    }
    const tabsAny = (c.tabs ?? {}) as Record<string, unknown>
    set(tabsAny, 'onUpdated', {
      addListener: (fn: (tabId: number, info: unknown, tab: unknown) => void) => {
        if (typeof fn === 'function' && !updatedListeners.includes(fn)) updatedListeners.push(fn)
        ready()
      },
      removeListener: (fn: (tabId: number, info: unknown, tab: unknown) => void) => {
        const i = updatedListeners.indexOf(fn)
        if (i >= 0) updatedListeners.splice(i, 1)
      },
      hasListener: (fn: (tabId: number, info: unknown, tab: unknown) => void) => updatedListeners.includes(fn)
    })
    const navEvent = (kind: string) => ({
      addListener: (fn: (d: unknown) => void) => {
        if (typeof fn === 'function' && !navListeners[kind].includes(fn)) navListeners[kind].push(fn)
        ready()
      },
      removeListener: (fn: (d: unknown) => void) => {
        const i = navListeners[kind].indexOf(fn)
        if (i >= 0) navListeners[kind].splice(i, 1)
      },
      hasListener: (fn: (d: unknown) => void) => navListeners[kind].includes(fn)
    })
    if (!c.webNavigation) {
      const frames = (d: unknown) => {
        const tabId = (d as { tabId?: unknown } | undefined)?.tabId
        return call('get', { tabId }).then((t) =>
          t ? [{ frameId: 0, parentFrameId: -1, processId: 0, url: (t as { url?: string }).url ?? '', errorOccurred: false }] : null
        )
      }
      set(c, 'webNavigation', {
        getAllFrames: (d: unknown, cb?: unknown) => reply(frames(d), cb),
        getFrame: (d: unknown, cb?: unknown) => reply(frames(d).then((f) => (f ? f[0] : null)), cb),
        onBeforeNavigate: noEvent,
        onCommitted: navEvent('committed'),
        onDOMContentLoaded: navEvent('domloaded'),
        onCompleted: navEvent('completed'),
        onErrorOccurred: noEvent,
        onCreatedNavigationTarget: noEvent,
        onReferenceFragmentUpdated: noEvent,
        onHistoryStateUpdated: noEvent,
        onTabReplaced: noEvent
      })
    }
    // chrome.action.setIcon — Electron 은 아이콘을 그리지 않는다. 메인에 알려 툴바가 바꿔 그리게 한다
    // (샵백은 활성화되면 초록 아이콘으로 바꾼다 — 2026-09-27). 원래 함수가 있으면 그것도 부른다
    const action = (c.action ?? {}) as Record<string, unknown>
    const origSetIcon = typeof action.setIcon === 'function' ? (action.setIcon as (...a: unknown[]) => unknown).bind(action) : null
    set(action, 'setIcon', (details: unknown, cb?: unknown) => {
      try {
        const d = (details ?? {}) as { path?: unknown }
        if (d.path !== undefined) notify('setIcon', { path: d.path })
      } catch {
        // 알림 실패는 무시
      }
      if (origSetIcon) {
        try {
          return reply(Promise.resolve(origSetIcon(details)).catch(() => undefined), cb)
        } catch {
          // Electron 이 거부해도 확장이 죽지 않게
        }
      }
      return reply(Promise.resolve(undefined), cb)
    })
    if (!c.action) set(c, 'action', action)
    // 크롬 프로필 계정 — 앱에는 없다. 빈 값을 준다
    if (!c.identity) {
      set(c, 'identity', {
        getProfileUserInfo: (...a: unknown[]) => reply(Promise.resolve({ email: '', id: '' }), lastFn(a))
      })
    }
  },
  args: [invokeTabs, subscribeNav, notifyAction, notifyReady]
})
