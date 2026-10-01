import { describe, it, expect, vi, beforeAll } from 'vitest'

// 서비스워커 preload 가 주입하는 함수를 그대로 실행해, chrome.tabs.get/query 가 status 를 돌려주는지 본다.
//
// 왜: Electron 기본 구현이 돌려주는 탭 객체에는 status 키가 아예 없다(실측 2026-10-01, Electron 39.8.10.
// WebContentsView 탭이든 BrowserWindow 든 같다). 확장이 적재 완료를 status === 'complete' 로 기다리면
// 영원히 끝나지 않는다 — 삼바웨이브 수집이 여기서 시간초과했다. 탭 목록 자체는 기본 구현이 제대로 보므로
// 다른 필드는 그대로 두고 앱 탭 브리지가 센 status 만 덧입힌다.

interface Injected {
  func: (...a: unknown[]) => void
  args?: unknown[]
}
const injected: Injected[] = []

vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: (o: Injected): number => injected.push(o) },
  ipcRenderer: { invoke: vi.fn(async () => null), on: vi.fn(), send: vi.fn() }
}))

/** 앱 탭 관리자가 보는 탭 — 하나는 적재 중, 하나는 끝난 상태로 둔다 */
const appTabs = [
  { id: 2, url: 'https://example.com/', title: 'done', status: 'complete' },
  { id: 3, url: 'https://example.org/', title: 'loading', status: 'loading' }
]

/** Electron 기본 chrome.tabs — status 를 넣지 않는 그 모양 그대로 흉내 낸다 */
function builtinChrome(): Record<string, unknown> {
  const runtime: { lastError?: { message: string } } = {}
  const bare = (t: (typeof appTabs)[number], i: number): Record<string, unknown> => ({
    id: t.id,
    index: i,
    windowId: 0,
    active: i === 0,
    highlighted: i === 0,
    pinned: false,
    incognito: false,
    url: t.url,
    title: t.title,
    groupId: -1,
    discarded: false
  })
  return {
    runtime,
    tabs: {
      get: (id: unknown, cb: (v: unknown) => void): void => {
        const i = appTabs.findIndex((t) => t.id === id)
        if (i < 0) {
          // 크롬은 콜백이 도는 동안만 lastError 를 세워 둔다
          runtime.lastError = { message: 'No such tab' }
          cb(undefined)
          delete runtime.lastError
          return
        }
        cb(bare(appTabs[i], i))
      },
      query: (_q: unknown, cb: (v: unknown) => void): void => {
        cb(appTabs.map(bare))
      }
    }
  }
}

type Chrome = Record<string, unknown>
let chrome: Chrome

beforeAll(async () => {
  await import('../src/preload/extension-sw')
  // 탭·창 API 를 주입하는 호출(인자 4개: call, listenNav, notify, ready)
  const tabsInjection = injected.find((o) => (o.args ?? []).length === 4)
  if (!tabsInjection) throw new Error('탭 API 주입 호출을 찾지 못했습니다')

  chrome = builtinChrome()
  ;(globalThis as unknown as { chrome?: Chrome }).chrome = chrome

  const call = async (op: string, details: unknown): Promise<unknown> => {
    if (op === 'query')
      return appTabs.map((t, i) => ({ ...t, index: i, windowId: 0, active: i === 0 }))
    if (op === 'get') {
      const id = (details as { tabId?: unknown }).tabId
      return appTabs.find((t) => t.id === id) ?? null
    }
    return null
  }
  tabsInjection.func(
    call,
    () => {},
    () => {},
    () => {}
  )
})

const tabsApi = (): Record<string, (...a: unknown[]) => unknown> =>
  chrome.tabs as Record<string, (...a: unknown[]) => unknown>

const viaCallback = (name: string, arg: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    tabsApi()[name](arg, (v: unknown) => resolve(v))
  })

describe('서비스워커 preload 의 chrome.tabs status', () => {
  it('tabs.get 이 앱이 센 status 를 채워 준다', async () => {
    const t = (await viaCallback('get', 2)) as { id: number; status: string }
    expect(t.status).toBe('complete')
    expect(t.id).toBe(2)
  })

  it('적재 중인 탭은 loading 으로 온다 — 상수로 박아 넣지 않는다', async () => {
    const t = (await viaCallback('get', 3)) as { status: string }
    expect(t.status).toBe('loading')
  })

  it('기본 구현이 주던 다른 필드는 그대로 남는다', async () => {
    const t = (await viaCallback('get', 2)) as Record<string, unknown>
    expect(t.groupId).toBe(-1)
    expect(t.discarded).toBe(false)
    expect(t.url).toBe('https://example.com/')
  })

  it('tabs.query 결과도 전부 status 를 갖는다', async () => {
    const list = (await viaCallback('query', {})) as Array<{ id: number; status: string }>
    expect(list.map((t) => `${t.id}:${t.status}`)).toEqual(['2:complete', '3:loading'])
  })

  it('없는 탭은 undefined 로 오고 lastError 를 읽을 수 있다', async () => {
    const seen = await new Promise<string>((resolve) => {
      tabsApi().get(99999, (v: unknown) => {
        const err = (chrome.runtime as { lastError?: { message: string } }).lastError
        resolve(`${v === undefined ? 'undefined' : String(v)}|${err?.message ?? 'NONE'}`)
      })
    })
    expect(seen).toBe('undefined|No such tab')
  })

  it('콜백을 주지 않으면 프로미스로 돌려주고, 없는 탭은 거부한다', async () => {
    const t = (await tabsApi().get(2)) as { status: string }
    expect(t.status).toBe('complete')
    await expect(tabsApi().get(99999) as Promise<unknown>).rejects.toThrow('No such tab')
  })
})
