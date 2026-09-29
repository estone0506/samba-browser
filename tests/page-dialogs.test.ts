// 페이지 JS 대화상자 자동 처리의 순수 판정 로직 검증(electron 없이 실행된다)

import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import type { WebContents } from 'electron'

vi.mock('../src/main/browser/emulation', () => ({
  ensureDebuggerAttached: () => true,
  keepDebuggerAttached: () => undefined
}))

import {
  decideDialog,
  describeDecision,
  DialogRepeatTracker,
  formatDialogNote,
  installDialogHandler,
  isAutomationActive,
  pageWhere
} from '../src/main/browser/dialogs'

describe('decideDialog', () => {
  it('자동화가 아닐 때 사람이 보는 탭의 첫 대화상자는 손대지 않는다', () => {
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
      expect(decideDialog(type, false)).toEqual({ handle: false, accept: false, ask: false })
    }
  })

  it('alert 는 알림일 뿐이라 어느 모드에서나 닫는다', () => {
    for (const mode of ['read_only', 'guard', 'full'] as const) {
      expect(decideDialog('alert', true, mode)).toEqual({
        handle: true,
        accept: true,
        ask: false
      })
    }
  })

  it('full 모드에서만 confirm/beforeunload 를 자동 확인한다', () => {
    expect(decideDialog('confirm', true, 'full')).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
    expect(decideDialog('beforeunload', true, 'full')).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
  })

  it('guard 모드의 confirm/beforeunload 는 사용자에게 물어본다', () => {
    expect(decideDialog('confirm', true, 'guard')).toEqual({
      handle: true,
      accept: false,
      ask: true
    })
    expect(decideDialog('beforeunload', true, 'guard')).toEqual({
      handle: true,
      accept: false,
      ask: true
    })
  })

  it('read_only 모드의 confirm/beforeunload 는 묻지도 않고 취소한다', () => {
    expect(decideDialog('confirm', true, 'read_only')).toEqual({
      handle: true,
      accept: false,
      ask: false
    })
    expect(decideDialog('beforeunload', true, 'read_only')).toEqual({
      handle: true,
      accept: false,
      ask: false
    })
  })

  it('모드를 주지 않으면 guard 로 본다(자동 확인하지 않는다)', () => {
    expect(decideDialog('confirm', true)).toEqual({ handle: true, accept: false, ask: true })
  })

  it('prompt 는 임의 입력이 되므로 취소한다', () => {
    expect(decideDialog('prompt', true)).toEqual({ handle: true, accept: false, ask: false })
  })
})

describe('isAutomationActive', () => {
  it('AI 작업이 돌면 활성', () => {
    expect(isAutomationActive(true, {})).toBe(true)
  })

  it('e2e 실행 중이면 작업이 없어도 활성', () => {
    expect(isAutomationActive(false, { SAMBA_E2E: '1' })).toBe(true)
    expect(isAutomationActive(false, { SAMBA_E2E: 'true' })).toBe(true)
  })

  it('둘 다 아니면 비활성', () => {
    expect(isAutomationActive(false, {})).toBe(false)
    expect(isAutomationActive(false, { SAMBA_E2E: '0' })).toBe(false)
  })

  it('패키징된 앱에서는 환경변수 스위치를 인정하지 않는다', () => {
    expect(isAutomationActive(false, { SAMBA_E2E: '1' }, false)).toBe(false)
    // AI 작업이 실제로 도는 중이면 그대로 활성이다
    expect(isAutomationActive(true, { SAMBA_E2E: '1' }, false)).toBe(true)
  })
})

describe('formatDialogNote', () => {
  it('공백을 정리해 한 줄 안내로 만든다', () => {
    expect(formatDialogNote('  재고가\n 없습니다.  ')).toBe('page dialog: "재고가 없습니다."')
  })

  it('아주 긴 문구는 잘라 낸다(도구 결과를 밀어내지 않게)', () => {
    const note = formatDialogNote('가'.repeat(1000))
    expect(note.length).toBeLessThan(330)
  })
})

describe('decideDialog — 작업이 없을 때(사람이 쓰는 중)', () => {
  const background = { userFacing: false, repeated: false }
  const repeated = { userFacing: true, repeated: true }
  const facing = { userFacing: true, repeated: false }

  it('사람이 보고 있지 않은 창(백그라운드·레인 탭)의 alert 는 닫는다', () => {
    expect(decideDialog('alert', false, 'guard', background)).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
  })

  it('같은 문구가 되풀이되면 보고 있는 탭이라도 닫는다', () => {
    expect(decideDialog('alert', false, 'guard', repeated)).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
  })

  it('사람이 보는 활성 탭의 첫 alert 는 기본 동작(창 표시)을 유지한다', () => {
    expect(decideDialog('alert', false, 'guard', facing).handle).toBe(false)
  })

  it('confirm/prompt/beforeunload 는 백그라운드·반복이어도 손대지 않는다(guard 정책 유지)', () => {
    for (const type of ['confirm', 'prompt', 'beforeunload']) {
      for (const ctx of [background, repeated]) {
        expect(decideDialog(type, false, 'full', ctx).handle).toBe(false)
      }
    }
  })

  it('작업 중 판정은 창 상황과 상관없이 예전 그대로다', () => {
    expect(decideDialog('confirm', true, 'guard', background)).toEqual({
      handle: true,
      accept: false,
      ask: true
    })
  })

  it('로그 문구에 자동 닫기 이유가 붙는다', () => {
    const d = decideDialog('alert', false, 'guard', background)
    expect(describeDecision(d, false, background)).toBe('확인(보고 있지 않은 창)')
    expect(describeDecision(d, false, repeated)).toBe('확인(반복)')
    expect(describeDecision(decideDialog('alert', false, 'guard', facing), false, facing)).toBe(
      '미처리(사용자가 보는 창)'
    )
    expect(describeDecision(decideDialog('alert', true), true, facing)).toBe('확인')
  })
})

describe('DialogRepeatTracker', () => {
  it('같은 문구가 창 안에 다시 오면 반복이다(공백 차이는 무시)', () => {
    const t = new DialogRepeatTracker(30_000)
    expect(t.note('선택한 상품이 없습니다.', 0)).toBe(false)
    expect(t.note(' 선택한  상품이 없습니다. ', 1_000)).toBe(true)
    expect(t.note('선택한 상품이 없습니다.', 2_000)).toBe(true)
  })

  it('다른 문구거나 시간이 지나면 반복이 아니다', () => {
    const t = new DialogRepeatTracker(30_000)
    t.note('A', 0)
    expect(t.note('B', 100)).toBe(false)
    expect(t.note('A', 40_000)).toBe(false)
  })
})

// 가짜 webContents — debugger 메시지를 흘려 보내고, 보낸 CDP 명령과 '-cancel-dialogs' 를 센다
function fakeWebContents(): {
  wc: WebContents
  debuggerEvents: EventEmitter
  commands: Array<{ method: string; params?: unknown }>
  cancels: () => number
} {
  const debuggerEvents = new EventEmitter()
  const commands: Array<{ method: string; params?: unknown }> = []
  const wcEvents = new EventEmitter()
  let cancelCount = 0
  wcEvents.on('-cancel-dialogs', () => {
    cancelCount += 1
  })
  const wc = Object.assign(wcEvents, {
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    debugger: Object.assign(debuggerEvents, {
      sendCommand: async (method: string, params?: unknown) => {
        commands.push({ method, params })
        return {}
      }
    })
  }) as unknown as WebContents
  return { wc, debuggerEvents, commands, cancels: () => cancelCount }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('installDialogHandler', () => {
  it('처리한 alert 는 CDP 로 닫고 Electron 네이티브 상자도 닫는다(쌓이지 않게)', async () => {
    const f = fakeWebContents()
    const messages: string[] = []
    installDialogHandler(f.wc, {
      isAutomationActive: () => true,
      mode: () => 'guard',
      onMessage: (m) => messages.push(m),
      repeats: new DialogRepeatTracker()
    })
    f.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: '선택한 상품이 없습니다.'
    })
    await flush()
    await flush()
    expect(f.commands).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true }
    })
    expect(f.cancels()).toBeGreaterThan(0)
    expect(messages).toEqual(['선택한 상품이 없습니다.'])
  })

  it('작업이 없어도 보고 있지 않은 탭의 alert 는 닫고, 도구 결과 안내는 남기지 않는다', async () => {
    const f = fakeWebContents()
    const messages: string[] = []
    installDialogHandler(f.wc, {
      isAutomationActive: () => false,
      isUserFacing: () => false,
      mode: () => 'guard',
      onMessage: (m) => messages.push(m),
      repeats: new DialogRepeatTracker()
    })
    f.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: '선택한 상품이 없습니다.'
    })
    await flush()
    await flush()
    expect(f.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(true)
    expect(f.cancels()).toBeGreaterThan(0)
    expect(messages).toEqual([])
  })

  it('사람이 보는 탭은 첫 alert 를 두고, 같은 문구가 되풀이되면 닫는다', async () => {
    const f = fakeWebContents()
    installDialogHandler(f.wc, {
      isAutomationActive: () => false,
      isUserFacing: () => true,
      mode: () => 'guard',
      onMessage: () => undefined,
      repeats: new DialogRepeatTracker()
    })
    const open = (): void => {
      f.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', {
        type: 'alert',
        message: '옵션을 선택해주세요.'
      })
    }
    open()
    await flush()
    expect(f.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false)
    expect(f.cancels()).toBe(0)
    open()
    await flush()
    await flush()
    expect(f.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(true)
    expect(f.cancels()).toBeGreaterThan(0)
  })

  it('confirm 은 작업이 없으면 보고 있지 않은 탭이라도 건드리지 않는다', async () => {
    const f = fakeWebContents()
    installDialogHandler(f.wc, {
      isAutomationActive: () => false,
      isUserFacing: () => false,
      mode: () => 'full',
      onMessage: () => undefined,
      repeats: new DialogRepeatTracker()
    })
    f.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: '주문 취소를 하시겠습니까?'
    })
    await flush()
    expect(f.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false)
    expect(f.cancels()).toBe(0)
  })
})

describe('pageWhere', () => {
  it('호스트와 경로만 남기고 쿼리는 버린다', () => {
    expect(pageWhere({ getURL: () => 'https://www.shop.com/cart/list?ordNo=123#x' })).toBe(
      'www.shop.com/cart/list'
    )
  })

  it('URL 이 아니면 ? 로 둔다', () => {
    expect(pageWhere({ getURL: () => '' })).toBe('?')
  })
})
