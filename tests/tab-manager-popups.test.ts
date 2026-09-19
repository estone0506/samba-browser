// 팝업 창(결제창·인증창) 수명주기 회귀 테스트.
// tab-manager 는 Electron 의존이 커서, 팝업 로직은 popups.ts 로 떼어 두고 여기서 순수하게 본다.
// 항해 가드(guardNavigation)는 tab-manager 에서 그대로 가져와 가짜 WebContents 로 확인한다

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PopupRegistry,
  POPUP_CLOSE_DELAY_MS,
  isQuitting,
  markQuitting,
  resetQuitting,
  type PopupEntry
} from '../src/main/browser/popups'
import { guardNavigation } from '../src/main/browser/tab-manager'

/** 가짜 팝업 창. 실제 BrowserWindow 는 만들지 않는다 */
class FakeWindow {
  destroyed = false
  hidden = false
  readonly log: string[] = []

  hide(): void {
    this.hidden = true
    this.log.push('hide')
  }

  /** 실제 Electron 처럼 close 는 'close' 이벤트를 거쳐 파괴된다(여기서는 호출만 센다) */
  close(): void {
    this.log.push('close')
  }

  destroy(): void {
    this.destroyed = true
    this.log.push('destroy')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function handleOf(win: FakeWindow): PopupEntry<FakeWindow>['handle'] {
  return {
    isDestroyed: () => win.isDestroyed(),
    hide: () => win.hide(),
    close: () => win.close(),
    destroy: () => win.destroy()
  }
}

/** 예약된 지연 작업을 테스트가 직접 돌린다 */
function makeRegistry(quitting = (): boolean => false): {
  registry: PopupRegistry<FakeWindow>
  add: (openerId?: string) => { entry: PopupEntry<FakeWindow>; win: FakeWindow }
  runTimers: () => void
  delays: number[]
} {
  const pending: Array<() => void> = []
  const delays: number[] = []
  const registry = new PopupRegistry<FakeWindow>({
    quitting,
    schedule: (fn, ms) => {
      delays.push(ms)
      pending.push(fn)
    }
  })
  let seq = 0
  return {
    registry,
    delays,
    add: (openerId = 'tab-1') => {
      const win = new FakeWindow()
      const entry = registry.add({
        id: `popup-${++seq}`,
        win,
        openerId,
        profile: 'default',
        handle: handleOf(win)
      })
      return { entry, win }
    },
    runTimers: () => {
      const items = pending.splice(0)
      for (const fn of items) fn()
    }
  }
}

describe('PopupRegistry 등록·정리', () => {
  it('등록한 팝업을 추적하고 remove 하면 목록에서 빠진다', () => {
    const { registry, add } = makeRegistry()
    const a = add('tab-1')
    const b = add('tab-2')
    expect(registry.alive()).toHaveLength(2)
    registry.remove(a.entry)
    expect(registry.alive()).toHaveLength(1)
    expect(registry.alive()[0].id).toBe(b.entry.id)
  })

  it('파괴된 창은 추적 목록에 남아 있어도 alive 에서 빠진다', () => {
    const { registry, add } = makeRegistry()
    const a = add()
    add()
    a.win.destroy()
    expect(registry.alive()).toHaveLength(1)
  })

  it('latestFor 는 그 탭이 띄운 가장 최근 팝업을 준다', () => {
    const { registry, add } = makeRegistry()
    add('tab-1')
    const second = add('tab-1')
    add('tab-2')
    expect(registry.latestFor('tab-1')?.id).toBe(second.entry.id)
    expect(registry.latestFor('tab-3')).toBeNull()
    second.win.destroy()
    // 살아 있는 것만 본다 — 파괴된 최신 팝업 대신 그 앞의 것을 돌려준다
    expect(registry.latestFor('tab-1')?.id).toBe('popup-1')
  })

  it('find 는 살아 있는 팝업 중에서만 찾는다', () => {
    const { registry, add } = makeRegistry()
    const a = add()
    expect(registry.find((p) => p.id === a.entry.id)).not.toBeNull()
    a.win.destroy()
    expect(registry.find((p) => p.id === a.entry.id)).toBeNull()
  })
})

describe('PopupRegistry.handleClose', () => {
  it('첫 close 는 preventDefault + 숨김 + 지연 예약, 두 번째는 그대로 닫는다', () => {
    const { registry, add, runTimers, delays } = makeRegistry()
    const { entry, win } = add()
    const first = vi.fn()
    registry.handleClose(entry, first)
    expect(first).toHaveBeenCalledTimes(1)
    expect(win.hidden).toBe(true)
    expect(delays).toEqual([POPUP_CLOSE_DELAY_MS])
    runTimers()
    expect(win.log).toEqual(['hide', 'close'])

    // 예약이 부른 close 로 다시 들어온 이벤트는 막지 않는다
    const second = vi.fn()
    registry.handleClose(entry, second)
    expect(second).not.toHaveBeenCalled()
  })

  it('앱 종료 중에는 close 를 미루지 않는다(app.quit() 취소 방지)', () => {
    const { registry, add, delays } = makeRegistry(() => true)
    const { entry, win } = add()
    const preventDefault = vi.fn()
    registry.handleClose(entry, preventDefault)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(win.hidden).toBe(false)
    expect(delays).toEqual([])
  })

  it('이미 파괴된 창은 건드리지 않는다', () => {
    const { registry, add } = makeRegistry()
    const { entry, win } = add()
    win.destroy()
    const preventDefault = vi.fn()
    registry.handleClose(entry, preventDefault)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('destroyAll 뒤에 들어온 close 는 미루지 않는다', () => {
    const { registry, add } = makeRegistry()
    const { entry } = add()
    registry.destroyAll()
    const preventDefault = vi.fn()
    registry.handleClose(entry, preventDefault)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('PopupRegistry.destroyAll', () => {
  it('남은 팝업을 모두 destroy 하고 목록을 비운다', () => {
    const { registry, add } = makeRegistry()
    const a = add()
    const b = add()
    registry.destroyAll()
    expect(a.win.destroyed).toBe(true)
    expect(b.win.destroyed).toBe(true)
    expect(registry.alive()).toHaveLength(0)
  })

  it('이미 파괴된 창은 다시 destroy 하지 않고, 두 번 불러도 안전하다', () => {
    const { registry, add } = makeRegistry()
    const a = add()
    a.win.destroy()
    a.win.log.length = 0
    registry.destroyAll()
    registry.destroyAll()
    expect(a.win.log).toEqual([])
  })

  it('지연 예약이 남아 있어도 파괴된 창을 다시 닫지 않는다', () => {
    const { registry, add, runTimers } = makeRegistry()
    const { entry, win } = add()
    registry.handleClose(entry, () => undefined)
    registry.destroyAll()
    runTimers()
    expect(win.log).toEqual(['hide', 'destroy'])
  })
})

describe('종료 표식', () => {
  beforeEach(() => resetQuitting())

  it('markQuitting 전에는 거짓, 부른 뒤에는 참이다', () => {
    expect(isQuitting()).toBe(false)
    markQuitting()
    expect(isQuitting()).toBe(true)
    resetQuitting()
    expect(isQuitting()).toBe(false)
  })

  it('기본 레지스트리는 모듈 전역 표식을 본다', () => {
    const registry = new PopupRegistry<FakeWindow>({ schedule: () => undefined })
    const win = new FakeWindow()
    const entry = registry.add({
      id: 'p',
      win,
      openerId: 'tab-1',
      profile: 'default',
      handle: handleOf(win)
    })
    markQuitting()
    const preventDefault = vi.fn()
    registry.handleClose(entry, preventDefault)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

// --- 항해 가드(C2) ----------------------------------------------------------

/** 가짜 WebContents — guardNavigation 이 거는 두 이벤트만 흉내 낸다 */
class FakeWebContents {
  private handlers = new Map<string, (e: { preventDefault: () => void }, url: string) => void>()

  on(event: string, cb: (e: { preventDefault: () => void }, url: string) => void): this {
    this.handlers.set(event, cb)
    return this
  }

  /** 이동을 시도한다. 막혔으면 true */
  navigate(event: 'will-navigate' | 'will-redirect', url: string): boolean {
    let blocked = false
    this.handlers.get(event)?.({ preventDefault: () => (blocked = true) }, url)
    return blocked
  }
}

describe('guardNavigation (팝업에도 붙는다)', () => {
  it('file:// · chrome-extension:// 이동을 막는다', () => {
    const wc = new FakeWebContents()
    guardNavigation(wc as unknown as Parameters<typeof guardNavigation>[0], false)
    expect(wc.navigate('will-navigate', 'file:///C:/Users/me/AppData/samba/data.db')).toBe(true)
    expect(wc.navigate('will-redirect', 'file:///C:/Users/me/AppData/samba/data.db')).toBe(true)
    expect(wc.navigate('will-navigate', 'chrome-extension://abc/popup.html')).toBe(true)
  })

  it('https 이동은 통과시킨다', () => {
    const wc = new FakeWebContents()
    guardNavigation(wc as unknown as Parameters<typeof guardNavigation>[0], false)
    expect(wc.navigate('will-navigate', 'https://pay.example.com/checkout')).toBe(false)
    expect(wc.navigate('will-redirect', 'https://pay.example.com/done')).toBe(false)
  })

  it('확장 문서 탭에서만 chrome-extension:// 이동이 열린다', () => {
    const wc = new FakeWebContents()
    guardNavigation(wc as unknown as Parameters<typeof guardNavigation>[0], true)
    expect(wc.navigate('will-navigate', 'chrome-extension://abc/options.html')).toBe(false)
    expect(wc.navigate('will-navigate', 'file:///C:/secret')).toBe(true)
  })
})
