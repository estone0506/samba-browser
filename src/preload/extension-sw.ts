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

contextBridge.executeInMainWorld({
  func: (call: (op: string, details: unknown) => Promise<unknown>): void => {
    const g = globalThis as unknown as { chrome?: Record<string, unknown> }
    if (!g.chrome || g.chrome.cookies) return
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
      // 변경 알림은 아직 없다 — 등록은 받아 두기만 한다(부르는 쪽이 죽지 않게)
      onChanged: { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
    }
  },
  args: [invoke]
})
