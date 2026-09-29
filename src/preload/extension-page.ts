// 확장 문서(팝업·옵션 페이지)에 Electron 이 주지 않는 chrome API 를 보충한다(main/extensions/page-api.ts 짝).
//
// - chrome.cookies: 팝업에는 아예 없다(애드픽 팝업이 로그인 확인에 쓴다)
// - chrome.windows: 없다 — 창은 앱 창 하나(번호 1)로 보인다
// - chrome.tabs.query/update/create/remove: Electron 팝업의 query({active}) 는 팝업 자기 자신을,
//   update({url}) 는 팝업을 이동시킨다. 크롬처럼 "사용자가 보고 있는 탭"을 가리키게 앱 탭으로 바꾼다
// 실제 처리는 메인이 한다 — 이 파일은 호출만 넘긴다.
import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL = 'samba-ext-page'

const invoke = (api: string, op: string, details: unknown): Promise<unknown> =>
  ipcRenderer.invoke(CHANNEL, api, op, details)

export function installExtensionPageApi(): void {
  contextBridge.executeInMainWorld({
    func: (call: (api: string, op: string, details: unknown) => Promise<unknown>): void => {
      type Cb = (v: unknown) => void
      const g = globalThis as unknown as { chrome?: Record<string, unknown> }
      const c = g.chrome
      if (!c) return
      // 마지막 인자가 함수면 콜백으로, 아니면 Promise 로 — 크롬 확장 API 와 같은 모양
      const reply = (p: Promise<unknown>, cb: unknown): Promise<unknown> | undefined => {
        if (typeof cb !== 'function') return p
        p.then(
          (v) => (cb as Cb)(v),
          () => (cb as Cb)(undefined)
        )
        return undefined
      }
      const lastFn = (args: unknown[]): unknown => (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined)
      const noEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
      const set = (o: Record<string, unknown>, k: string, v: unknown): void => {
        try {
          o[k] = v
        } catch {
          Object.defineProperty(o, k, { value: v, configurable: true })
        }
      }

      if (!c.cookies) {
        const op = (name: string) => (details: unknown, cb?: unknown) => reply(call('cookies', name, details), cb)
        set(c, 'cookies', {
          get: op('get'),
          getAll: op('getAll'),
          set: op('set'),
          remove: op('remove'),
          getAllCookieStores: (cb?: unknown) => reply(Promise.resolve([{ id: '0', tabIds: [] }]), cb),
          onChanged: noEvent
        })
      }

      const tabs = (c.tabs ?? {}) as Record<string, unknown>
      set(tabs, 'query', (q: unknown, cb?: unknown) => reply(call('tabs', 'query', q ?? {}), cb))
      set(tabs, 'create', (props: unknown, cb?: unknown) => reply(call('tabs', 'create', props ?? {}), cb))
      set(tabs, 'update', (...a: unknown[]) => {
        const cb = lastFn(a)
        const hasId = typeof a[0] === 'number'
        return reply(call('tabs', 'update', { tabId: hasId ? a[0] : null, props: hasId ? a[1] : a[0] }), cb)
      })
      set(tabs, 'remove', (ids: unknown, cb?: unknown) => reply(call('tabs', 'remove', { tabIds: ids }), cb))
      if (!c.tabs) set(c, 'tabs', tabs)

      if (!c.windows) {
        const win = (info: unknown, cb: unknown) => reply(call('tabs', 'windowGet', info ?? {}), cb)
        set(c, 'windows', {
          WINDOW_ID_NONE: -1,
          WINDOW_ID_CURRENT: -2,
          get: (...a: unknown[]) => win(typeof a[1] === 'object' ? a[1] : {}, lastFn(a)),
          getCurrent: (...a: unknown[]) => win(typeof a[0] === 'object' ? a[0] : {}, lastFn(a)),
          getLastFocused: (...a: unknown[]) => win(typeof a[0] === 'object' ? a[0] : {}, lastFn(a)),
          getAll: (...a: unknown[]) =>
            reply(
              call('tabs', 'windowGet', typeof a[0] === 'object' ? a[0] : {}).then((w) => [w]),
              lastFn(a)
            ),
          // 새 창 대신 새 탭으로 연다(앱은 창 하나)
          create: (d: unknown, cb?: unknown) => {
            const url = (d as { url?: unknown } | undefined)?.url
            const first = Array.isArray(url) ? url[0] : url
            return reply(
              call('tabs', 'create', { url: typeof first === 'string' ? first : undefined }).then(() =>
                call('tabs', 'windowGet', {})
              ),
              cb
            )
          },
          update: (_id: unknown, _info: unknown, cb?: unknown) => win({}, cb),
          remove: (_id: unknown, cb?: unknown) => reply(Promise.resolve(undefined), cb),
          onCreated: noEvent,
          onRemoved: noEvent,
          onFocusChanged: noEvent
        })
      }
    },
    args: [invoke]
  })
}
