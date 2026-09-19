import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { PageElement, PageSnapshot } from '../src/shared/snapshot'

// frame-channel 은 electron 의 ipcMain 으로 프레임 응답을 받는다.
// 여기서는 그 통로를 가짜로 바꿔, 프레임 호출이 "어떤 프레임에 어떤 동작으로" 갔는지만 본다
const { frameCalls, frameReply } = vi.hoisted(() => ({
  frameCalls: [] as { host: string; op: Record<string, unknown> }[],
  frameReply: { fail: new Set<string>() }
}))

vi.mock('../src/main/browser/frame-channel', () => ({
  FRAME_CALL_TIMEOUT_MS: 8000,
  callFrameOp: async (frame: { url: string; result: unknown }, op: Record<string, unknown>) => {
    const host = new URL(frame.url).host
    frameCalls.push({ host, op })
    if (frameReply.fail.has(host)) throw new Error('frame call failed')
    return frame.result
  },
  clearFrameCalls: (): void => undefined
}))

const { pageBridge } = await import('../src/main/browser/page-bridge')

function el(id: number, text = ''): PageElement {
  return { id, tag: 'button', role: 'button', text, isSecret: false }
}

function snap(url: string, elements: PageElement[], text = ''): PageSnapshot {
  return { url, title: '', text, elements, total: elements.length }
}

interface FakeFrame {
  url: string
  result: unknown
}

/** 메인 프레임 결과 + 하위 프레임 목록을 가진 가짜 탭 */
function fakeTab(mainResult: unknown, frames: FakeFrame[]): { tab: Tab; mainCalls: string[] } {
  const mainCalls: string[] = []
  // framesInSubtree 는 메인 프레임 자신을 맨 앞에 담는다(같은 객체여야 걸러진다)
  const mainFrame: { url: string; framesInSubtree: unknown[] } = {
    url: 'https://order.29cm.co.kr/order',
    framesInSubtree: []
  }
  mainFrame.framesInSubtree = [mainFrame, ...frames]
  const webContents = {
    isDestroyed: () => false,
    mainFrame,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      mainCalls.push(scripts[0].code)
      return mainResult
    }
  }
  return { tab: { view: { webContents } } as unknown as Tab, mainCalls }
}

const POSTCODE = 'https://postcode.map.daum.net/guide'

beforeEach(() => {
  frameCalls.length = 0
  frameReply.fail.clear()
})

describe('pageBridge.snapshot: iframe 합치기', () => {
  it('메인 프레임과 iframe 요소를 한 목록으로 돌려준다', async () => {
    const { tab, mainCalls } = fakeTab(
      snap('https://order.29cm.co.kr/order', [el(1, '주문하기')], '주문서'),
      [{ url: POSTCODE, result: snap(POSTCODE, [el(2, '검색')], '우편번호') }]
    )
    const s = await pageBridge.snapshot(tab)
    expect(mainCalls).toEqual(['__samba.snapshot()'])
    expect(frameCalls).toEqual([{ host: 'postcode.map.daum.net', op: { op: 'snapshot' } }])
    expect(s.elements.map((e) => e.id)).toEqual([1, 100002])
    expect(s.elements[1].frame).toEqual({ index: 1, host: 'postcode.map.daum.net' })
  })

  it('실패한 프레임은 건너뛰고 나머지는 그대로 쓴다', async () => {
    frameReply.fail.add('postcode.map.daum.net')
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: POSTCODE, result: snap(POSTCODE, [el(2)]) },
      {
        url: 'https://zip.musinsa.com/z',
        result: snap('https://zip.musinsa.com/z', [el(2, '주소')])
      }
    ])
    const s = await pageBridge.snapshot(tab)
    // 1번 프레임이 실패했으므로 2번 프레임 요소만 남는다(번호는 프레임 순서 그대로)
    expect(s.elements.map((e) => e.id)).toEqual([1, 200002])
    expect(s.elements[1].frame?.host).toBe('zip.musinsa.com')
  })

  it('about:blank·빈 프레임은 열거하지 않는다', async () => {
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: 'about:blank', result: snap('about:blank', [el(9)]) },
      { url: '', result: snap('', [el(9)]) }
    ])
    const s = await pageBridge.snapshot(tab)
    expect(frameCalls).toEqual([])
    expect(s.elements.map((e) => e.id)).toEqual([1])
  })

  it('요소도 글도 없는 프레임(광고 iframe)은 목록에 넣지 않는다', async () => {
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: 'https://ads.example/x', result: snap('https://ads.example/x', []) }
    ])
    const s = await pageBridge.snapshot(tab)
    expect(s.elements.map((e) => e.id)).toEqual([1])
  })
})

describe('pageBridge 행동 도구: id 로 프레임을 가른다', () => {
  it('메인 프레임 id 는 예전처럼 격리 월드에서 실행한다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.click(tab, 7)).toBe('ok')
    expect(mainCalls).toEqual(['__samba.click(7)'])
    expect(frameCalls).toEqual([])
  })

  it('프레임 id 는 그 프레임에 지역 id 로 전달한다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.click(tab, 100015)).toBe('ok')
    expect(mainCalls).toEqual([])
    expect(frameCalls).toEqual([{ host: 'postcode.map.daum.net', op: { op: 'click', id: 15 } }])
  })

  it('type·select·textOf·submitForm 도 같은 프레임으로 간다', async () => {
    const { tab } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    await pageBridge.type(tab, 100003, '서울시 강남구', true)
    await pageBridge.select(tab, 100004, '서울')
    await pageBridge.textOf(tab, 100005)
    await pageBridge.submitForm(tab, 100006)
    expect(frameCalls.map((c) => c.op)).toEqual([
      { op: 'type', id: 3, text: '서울시 강남구', submit: true },
      { op: 'select', id: 4, value: '서울' },
      { op: 'textOf', id: 5 },
      { op: 'submitForm', id: 6 }
    ])
    expect(frameCalls.every((c) => c.host === 'postcode.map.daum.net')).toBe(true)
  })

  it('scroll 은 id 를 주면 그 프레임, 안 주면 메인 프레임이다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    await pageBridge.scroll(tab, 'down')
    await pageBridge.scroll(tab, 'down', 100009)
    expect(mainCalls).toEqual(['__samba.scroll("down")'])
    expect(frameCalls.map((c) => c.op)).toEqual([{ op: 'scroll', dir: 'down', id: 9 }])
  })

  it('fillValue 는 프레임에 맡기고, 값이 담긴 코드 문자열을 만들지 않는다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.fillValue(tab, 100002, '비밀값')).toBe('ok')
    expect(mainCalls).toEqual([])
    expect(frameCalls).toEqual([
      { host: 'postcode.map.daum.net', op: { op: 'fillValue', id: 2, value: '비밀값' } }
    ])
  })

  it('가리키는 프레임이 사라졌으면 오류를 던진다', async () => {
    const { tab } = fakeTab('ok', [])
    await expect(pageBridge.click(tab, 300001)).rejects.toThrow('frame 3 is gone')
  })
})

describe('pageBridge.keypadSignalsAll', () => {
  it('메인 프레임 신호를 먼저, 그다음 프레임 신호를 돌려준다', async () => {
    const mainSignals = {
      url: 'https://pay.example/',
      text: '결제 비밀번호',
      digitButtons: 0,
      pinField: false
    }
    const frameSignals = {
      url: 'https://kpad.payco.com/',
      text: '',
      digitButtons: 10,
      pinField: false
    }
    const { tab } = fakeTab(mainSignals, [{ url: 'https://kpad.payco.com/', result: frameSignals }])
    expect(await pageBridge.keypadSignalsAll(tab)).toEqual([mainSignals, frameSignals])
  })
})
