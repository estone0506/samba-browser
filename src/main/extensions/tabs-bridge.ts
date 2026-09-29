// 확장 문서(팝업·옵션)와 서비스워커에 Electron 이 주지 않는 탭·창 API 를 앱의 탭 관리자로 처리한다.
// preload/extension-page.ts·extension-sw.ts 짝.
//
// 왜: 애드픽 팝업은 chrome.windows·chrome.cookies·tabs.create 를 쓰고, tabs.query({active}) 로
// 사용자가 보던 쇼핑 페이지를 찾는다. Electron 팝업에는 셋 다 없고 query 는 팝업 자기 자신을
// 돌려줘 "이 페이지 적립 링크 만들기"가 통째로 안 됐다(실기 2026-09-26).
//
// 크롬 탭 id 는 webContents.id 를 쓴다 — Electron 기본 chrome.tabs.get/sendMessage 와 같은 번호다.
import type { Session, WebContents } from 'electron'

/** 크롬 확장 API 의 Tab 모양(쓰는 필드만) */
export interface ChromeTab {
  id: number
  index: number
  windowId: number
  active: boolean
  highlighted: boolean
  pinned: boolean
  incognito: boolean
  url: string
  title: string
  status: 'loading' | 'complete'
}

/** 앱 창 하나 — Electron 기본 chrome.tabs 가 주는 창 번호(0)와 같게 둔다(섞어 쓰는 확장이 현재 창 판정을 틀리지 않게) */
export const WINDOW_ID = 0

/** 탭 관리자가 이 다리에 주는 것(테스트 대역으로 갈아 끼운다) */
export interface ExtensionTabsProvider {
  /** 탭 목록(앞→뒤 순서) */
  tabs(): Array<{ wc: WebContents; active: boolean; profile: string }>
  /** 새 탭 — 만든 탭의 webContents */
  create(url: string, profile: string, active: boolean): WebContents | null
  /** webContents 로 탭 닫기 */
  close(wc: WebContents): void
  /** webContents 로 탭 활성화 */
  activate(wc: WebContents): void
  /** 이 세션을 쓰는 프로필 이름(모르면 'default') */
  profileOf(ses: Session): string
}

let provider: ExtensionTabsProvider | null = null

/** 창이 만들어질 때 탭 관리자를 꽂는다(창 1개 앱) */
export function setExtensionTabsProvider(p: ExtensionTabsProvider | null): void {
  provider = p
}

/** webContents → 크롬 Tab(순수에 가깝게 — webContents 에서 읽기만) */
export function toChromeTab(wc: WebContents, index: number, active: boolean): ChromeTab {
  return {
    id: wc.id,
    index,
    windowId: WINDOW_ID,
    active,
    highlighted: active,
    pinned: false,
    incognito: false,
    url: wc.getURL(),
    title: wc.getTitle(),
    status: wc.isLoading() ? 'loading' : 'complete'
  }
}

type Details = Record<string, unknown>

const obj = (v: unknown): Details => (typeof v === 'object' && v !== null ? (v as Details) : {})

/** 확장이 열 수 있는 주소 — 웹 주소와 그 확장 자신의 문서만 */
export function allowedTabUrl(url: string, extensionId: string): boolean {
  if (/^https?:\/\//i.test(url)) return true
  return url.startsWith(`chrome-extension://${extensionId}/`)
}

/** query 조건에 맞는가(active·url 글자 일부·windowId 만 본다) */
export function matchesQuery(tab: ChromeTab, q: Details): boolean {
  if (typeof q.active === 'boolean' && tab.active !== q.active) return false
  if (typeof q.windowId === 'number' && q.windowId >= 0 && q.windowId !== WINDOW_ID) return false
  if (typeof q.url === 'string' && q.url) {
    // 크롬 match pattern 을 간단히 — '*' 만 와일드카드로 본다
    const re = new RegExp('^' + q.url.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    if (!re.test(tab.url)) return false
  }
  return true
}

/** 지금 보이는(활성) 탭의 webContents id 인가 — 이동 알림에 active 를 실어 보낼 때 쓴다 */
export function isActiveTabId(wcId: number): boolean {
  if (!provider) return false
  return provider.tabs().some((t) => t.active && t.wc.id === wcId)
}

/** 탭·창 동작 하나. ses 는 호출한 확장 문서(서비스워커)의 세션 */
export function runTabsOp(op: string, raw: unknown, ses: Session, extensionId: string): unknown {
  if (!provider) return null
  const p = provider
  const d = obj(raw)
  const all = p.tabs().map((t, i) => ({ ...t, tab: toChromeTab(t.wc, i, t.active) }))
  const byId = (id: unknown): (typeof all)[number] | undefined =>
    typeof id === 'number' ? all.find((t) => t.wc.id === id) : undefined
  const activeOne = all.find((t) => t.active)
  // 확장의 탭 동작 기록 — 주소만 남긴다(샵백 활성화 흐름 추적, 2026-09-27)
  if (op === 'update' || op === 'create' || op === 'remove') {
    const props = obj(d.props)
    console.log('[ext-tabs]', extensionId.slice(0, 8), op, JSON.stringify({ tabId: d.tabId, url: d.url ?? props.url, active: d.active ?? props.active }).slice(0, 200))
  }
  switch (op) {
    case 'query':
      return all.map((t) => t.tab).filter((t) => matchesQuery(t, d))
    case 'get':
      return byId(d.tabId)?.tab ?? null
    case 'create': {
      const url = typeof d.url === 'string' && d.url ? d.url : 'about:blank'
      if (url !== 'about:blank' && !allowedTabUrl(url, extensionId)) return null
      const wc = p.create(url, p.profileOf(ses), d.active !== false)
      if (!wc) return null
      const i = p.tabs().findIndex((t) => t.wc === wc)
      return toChromeTab(wc, i < 0 ? all.length : i, d.active !== false)
    }
    case 'update': {
      // tabId 가 없으면 지금 보고 있는 탭(크롬과 같다)
      const target = d.tabId === undefined || d.tabId === null ? activeOne : byId(d.tabId)
      if (!target) return null
      const props = obj(d.props)
      if (typeof props.url === 'string' && props.url) {
        if (!allowedTabUrl(props.url, extensionId)) return null
        void target.wc.loadURL(props.url).catch(() => {})
      }
      if (props.active === true) p.activate(target.wc)
      return target.tab
    }
    case 'remove': {
      const ids = Array.isArray(d.tabIds) ? d.tabIds : [d.tabIds]
      for (const id of ids) {
        const t = byId(id)
        if (t) p.close(t.wc)
      }
      return true
    }
    case 'windowGet':
      return {
        id: WINDOW_ID,
        focused: true,
        incognito: false,
        type: 'normal',
        state: 'normal',
        alwaysOnTop: false,
        ...(d.populate ? { tabs: all.map((t) => t.tab) } : {})
      }
    default:
      return null
  }
}

/**
 * 확장 팝업이 연 새 창(로그인 페이지 등)을 그 세션 프로필의 새 탭으로 연다 — 크롬도 팝업에서 뜬 창은 탭으로 보낸다.
 * 웹 주소만. 열었으면 true
 */
export function openTabFromExtension(url: string, ses: Session): boolean {
  if (!provider || !/^https?:\/\//i.test(url)) return false
  return provider.create(url, provider.profileOf(ses), true) !== null
}
