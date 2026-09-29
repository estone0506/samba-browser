// 확장 탭·창 다리 — 팝업의 tabs.query({active}) 가 사용자가 보던 탭을, create·update·remove 가 앱 탭을 다룬다

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session, WebContents } from 'electron'
import {
  allowedTabUrl,
  matchesQuery,
  openTabFromExtension,
  runTabsOp,
  setExtensionTabsProvider,
  toChromeTab,
  WINDOW_ID,
  type ExtensionTabsProvider
} from '../src/main/extensions/tabs-bridge'

const EXT = 'chjgdkpobojcndfcmondbplekkffknod'
const ses = {} as Session

function fakeWc(id: number, url: string): WebContents {
  return {
    id,
    getURL: () => url,
    getTitle: () => `t${id}`,
    isLoading: () => false,
    loadURL: vi.fn(async () => {})
  } as unknown as WebContents
}

let list: Array<{ wc: WebContents; active: boolean; profile: string }>
let provider: ExtensionTabsProvider

beforeEach(() => {
  list = [
    { wc: fakeWc(11, 'https://www.musinsa.com/products/1'), active: false, profile: 'default' },
    { wc: fakeWc(12, 'https://www.ssg.com/item/2'), active: true, profile: 'default' }
  ]
  provider = {
    tabs: () => list,
    create: vi.fn((url: string, profile: string, active: boolean) => {
      const wc = fakeWc(20, url)
      list.push({ wc, active, profile })
      return wc
    }),
    close: vi.fn(),
    activate: vi.fn(),
    profileOf: () => 'buyer01'
  }
  setExtensionTabsProvider(provider)
})

describe('runTabsOp', () => {
  it('query({active}) 는 팝업이 아니라 지금 보고 있는 앱 탭을 돌려준다', () => {
    const out = runTabsOp('query', { active: true, windowId: -2 }, ses, EXT) as Array<{ id: number; url: string }>
    expect(out.map((t) => t.id)).toEqual([12])
    expect(out[0].url).toBe('https://www.ssg.com/item/2')
  })

  it('create 는 호출한 세션의 프로필로 탭을 연다', () => {
    const tab = runTabsOp('create', { url: 'https://adpick.co.kr/' }, ses, EXT) as { id: number }
    expect(provider.create).toHaveBeenCalledWith('https://adpick.co.kr/', 'buyer01', true)
    expect(tab.id).toBe(20)
  })

  it('웹 주소·자기 확장 문서만 연다(다른 스킴은 거절)', () => {
    expect(runTabsOp('create', { url: 'file:///C:/x' }, ses, EXT)).toBeNull()
    expect(runTabsOp('create', { url: 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/x.html' }, ses, EXT)).toBeNull()
    expect(provider.create).not.toHaveBeenCalled()
  })

  it('update 에 tabId 가 없으면 보고 있는 탭을 이동시킨다(적립 링크)', () => {
    runTabsOp('update', { tabId: null, props: { url: 'https://adpick.co.kr/track?x=1' } }, ses, EXT)
    expect(list[1].wc.loadURL).toHaveBeenCalledWith('https://adpick.co.kr/track?x=1')
    expect(list[0].wc.loadURL).not.toHaveBeenCalled()
  })

  it('remove 는 id 로 찾은 탭만 닫는다', () => {
    runTabsOp('remove', { tabIds: [11, 99] }, ses, EXT)
    expect(provider.close).toHaveBeenCalledTimes(1)
    expect(provider.close).toHaveBeenCalledWith(list[0].wc)
  })

  it('windowGet 은 앱 창 하나를 돌려준다(populate 면 탭 포함)', () => {
    const w = runTabsOp('windowGet', { populate: true }, ses, EXT) as { id: number; tabs: unknown[] }
    expect(w.id).toBe(WINDOW_ID)
    expect(w.tabs).toHaveLength(2)
  })

  it('탭 관리자가 없으면 null', () => {
    setExtensionTabsProvider(null)
    expect(runTabsOp('query', {}, ses, EXT)).toBeNull()
  })
})

describe('보조 함수', () => {
  it('matchesQuery 는 url 패턴의 * 를 와일드카드로 본다', () => {
    const t = toChromeTab(fakeWc(1, 'https://www.ssg.com/item/2'), 0, true)
    expect(matchesQuery(t, { url: 'https://*.ssg.com/*' })).toBe(true)
    expect(matchesQuery(t, { url: 'https://*.musinsa.com/*' })).toBe(false)
    expect(matchesQuery(t, { active: false })).toBe(false)
  })

  it('allowedTabUrl', () => {
    expect(allowedTabUrl('https://a.com', EXT)).toBe(true)
    expect(allowedTabUrl(`chrome-extension://${EXT}/index.html`, EXT)).toBe(true)
    expect(allowedTabUrl('javascript:alert(1)', EXT)).toBe(false)
  })
})

describe('openTabFromExtension — 팝업이 연 새 창(로그인 페이지)을 새 탭으로', () => {
  it('웹 주소는 그 세션 프로필의 새 탭으로 연다', () => {
    expect(openTabFromExtension('https://www.shopback.co.kr/login', ses)).toBe(true)
    expect(provider.create).toHaveBeenCalledWith('https://www.shopback.co.kr/login', 'buyer01', true)
  })

  it('웹 주소가 아니면 열지 않는다', () => {
    expect(openTabFromExtension('file:///C:/x', ses)).toBe(false)
    expect(provider.create).not.toHaveBeenCalled()
  })
})
