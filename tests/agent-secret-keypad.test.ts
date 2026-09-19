import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { Tab } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { HandoffResult } from '../src/main/agent/handoff'
import type { KeypadSignals } from '../src/shared/snapshot'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부른다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    snapshot: vi.fn(async () => ({
      url: 'https://shop.example/',
      title: '',
      text: '',
      elements: []
    })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    fillValue: vi.fn(async () => 'ok'),
    isSecretField: vi.fn(async () => true),
    waitForLoad: vi.fn(async () => {}),
    // 기본값은 beforeEach 에서 넣는다(hoist 시점에는 아래 상수를 참조할 수 없다)
    keypadSignals: vi.fn()
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const {
  createSecretKeypadGate,
  isPinAuthUrl,
  isSecretKeypad,
  secretKeypadReason,
  secretKeypadGate,
  DIGIT_BUTTON_MIN
} = await import('../src/main/agent/secret-page')
const { createSambaTools, PAYMENT_KEYPAD_REFUSAL, SECRET_SCREEN_REFUSAL, KEYPAD_HANDOFF_MESSAGE } =
  await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

// 일반 화면 신호(비밀 키패드 아님)
const plain: KeypadSignals = {
  url: 'https://shop.example/cart',
  text: '장바구니 주문하기',
  digitButtons: 0,
  pinField: false
}

const signals = (over: Partial<KeypadSignals> = {}): KeypadSignals => ({ ...plain, ...over })

describe('비밀 키패드 판정(순수 함수)', () => {
  it('숫자 버튼 10개 + 결제 비밀번호 문구면 키패드로 본다', () => {
    const s = signals({ digitButtons: DIGIT_BUTTON_MIN, text: '결제 비밀번호를 입력하세요' })
    expect(secretKeypadReason(s)).toBe('digit-keypad')
    expect(isSecretKeypad(s)).toBe(true)
  })

  it('영문 PIN 문구도 잡는다', () => {
    expect(isSecretKeypad(signals({ digitButtons: 12, text: 'Enter your PIN' }))).toBe(true)
  })

  it('숫자 버튼만 많고 문구가 없으면 키패드가 아니다(계산기·전화번호 입력)', () => {
    expect(secretKeypadReason(signals({ digitButtons: 12, text: '수량을 고르세요' }))).toBeNull()
  })

  it('문구만 있고 숫자 버튼이 모자라면 키패드가 아니다', () => {
    expect(secretKeypadReason(signals({ digitButtons: 9, text: '결제 비밀번호' }))).toBeNull()
  })

  it('짧은 비밀 입력칸(pinField)만으로도 키패드로 본다', () => {
    expect(secretKeypadReason(signals({ pinField: true }))).toBe('pin-field')
  })

  it('평범한 장바구니 화면은 키패드가 아니다', () => {
    expect(isSecretKeypad(plain)).toBe(false)
  })
})

describe('PIN 인증 주소 정규식', () => {
  it.each([
    'https://cert.vno.co.kr/app/pinCert.do?param=1',
    'https://pay.example.com/pin/input',
    'https://order.musinsa.com/simplepay/password',
    'https://pg.kakaopay.com/v1/pw/confirm',
    'https://pay.toss.im/web/pin',
    'https://alpha.payco.com/order/pin'
  ])('%s 는 PIN 인증 경로다', (url) => {
    expect(isPinAuthUrl(url)).toBe(true)
    expect(secretKeypadReason(signals({ url }))).toBe('pin-url')
  })

  it.each([
    'https://www.musinsa.com/app/goods/123',
    'https://shop.example/checkout',
    'https://pay.example.com/pinned-items'
  ])('%s 는 PIN 인증 경로가 아니다', (url) => {
    expect(isPinAuthUrl(url)).toBe(false)
  })
})

describe('스캔 캐시', () => {
  const tab = { id: 't1' } as unknown as Tab

  it('500ms 안에는 페이지를 한 번만 읽는다', async () => {
    let clock = 0
    const read = vi.fn(async () => plain)
    const gate = createSecretKeypadGate({ read, urlOf: () => plain.url, now: () => clock })
    await gate.check(tab)
    await gate.check(tab)
    expect(read).toHaveBeenCalledTimes(1)
    clock = 501
    await gate.check(tab)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('fresh 면 캐시를 건너뛴다', async () => {
    const read = vi.fn(async () => plain)
    const gate = createSecretKeypadGate({ read, urlOf: () => plain.url, now: () => 0 })
    await gate.check(tab)
    await gate.check(tab, { fresh: true })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('페이지를 읽지 못하면 주소만으로 판정한다', async () => {
    const read = vi.fn(async () => {
      throw new Error('page is gone')
    })
    const pin = createSecretKeypadGate({
      read,
      urlOf: () => 'https://cert.vno.co.kr/app/pinCert.do',
      now: () => 0
    })
    expect(await pin.check(tab)).toBe('pin-url')
    const normal = createSecretKeypadGate({ read, urlOf: () => plain.url, now: () => 0 })
    expect(await normal.check({ id: 't2' } as unknown as Tab)).toBeNull()
  })
})

// --- 도구 차단 -------------------------------------------------------------

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 'keypad-tab',
  view: {
    webContents: { getURL: () => 'https://order.musinsa.com/checkout', isDestroyed: () => false },
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 })
  },
  profile: 'default',
  mobile: false
}

function build(
  opts: {
    handoff?: ToolContext['handoff']
    vault?: ToolContext['vault']
  } = {}
): { tools: ToolStub[]; steps: Array<{ label: string; ok: boolean }> } {
  const steps: Array<{ label: string; ok: boolean }> = []
  const tabs = {
    active: () => fakeTab,
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'full',
    finalConfirm: false,
    confirm: async () => true,
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok }),
    ...opts
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, steps }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const textOut = (r: { content: { text: string }[] }): string => r.content[0].text

beforeEach(() => {
  secretKeypadGate.clear()
  pageBridge.click.mockClear()
  pageBridge.type.mockClear()
  pageBridge.select.mockClear()
  pageBridge.scroll.mockClear()
  pageBridge.fillValue.mockClear()
  pageBridge.keypadSignals.mockReset()
  pageBridge.keypadSignals.mockResolvedValue(plain)
})

describe('키패드 화면에서는 조작 도구가 거부한다', () => {
  const keypad = signals({ digitButtons: 10, text: '결제 비밀번호 6자리를 입력해 주세요' })

  it('click 이 거부되고 페이지를 누르지 않는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const { tools, steps } = build()
    const r = await get(tools, 'click').handler({ id: 3, label: '5' })
    expect(textOut(r)).toBe(PAYMENT_KEYPAD_REFUSAL)
    expect(pageBridge.click).not.toHaveBeenCalled()
    expect(steps.at(-1)?.ok).toBe(false)
  })

  it('type·select·scroll 도 거부된다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const { tools } = build()
    expect(
      textOut(await get(tools, 'type').handler({ id: 1, text: '123456', submit: false }))
    ).toBe(PAYMENT_KEYPAD_REFUSAL)
    expect(textOut(await get(tools, 'select').handler({ id: 1, value: 'a' }))).toBe(
      PAYMENT_KEYPAD_REFUSAL
    )
    expect(textOut(await get(tools, 'scroll').handler({ direction: 'down' }))).toBe(
      PAYMENT_KEYPAD_REFUSAL
    )
    expect(pageBridge.type).not.toHaveBeenCalled()
    expect(pageBridge.select).not.toHaveBeenCalled()
    expect(pageBridge.scroll).not.toHaveBeenCalled()
  })

  it('화면 캡처는 폰과 같은 톤으로 거부한다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const { tools } = build()
    expect(textOut(await get(tools, 'screenshot').handler({}))).toBe(SECRET_SCREEN_REFUSAL)
  })

  it('스캔은 도구 호출당 1회다(캐시)', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const { tools } = build()
    await get(tools, 'click').handler({ id: 1, label: '1' })
    await get(tools, 'click').handler({ id: 2, label: '2' })
    expect(pageBridge.keypadSignals).toHaveBeenCalledTimes(1)
  })
})

describe('일반 화면에서는 그대로 통과한다', () => {
  it('click 이 실행된다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(plain)
    const { tools } = build()
    const r = await get(tools, 'click').handler({ id: 3, label: '장바구니' })
    expect(textOut(r)).toBe('ok')
    expect(pageBridge.click).toHaveBeenCalledWith(fakeTab, 3)
  })

  it('scroll 이 실행된다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(plain)
    const { tools } = build()
    expect(textOut(await get(tools, 'scroll').handler({ direction: 'down' }))).toBe('ok')
  })
})

describe('fill_secret 은 키패드 화면에서 사람에게 넘긴다', () => {
  const keypad = signals({ url: 'https://cert.vno.co.kr/app/pinCert.do' })

  it('넘김이 배선돼 있으면 handoff 결과를 돌려준다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const handoff = vi.fn(async (): Promise<HandoffResult> => ({
      outcome: 'skipped',
      url: keypad.url
    }))
    const { tools } = build({ handoff })
    const r = await get(tools, 'fill_secret').handler({
      elementId: 2,
      itemType: 'password',
      provider: 'site'
    })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(handoff.mock.calls[0][0].matched).toBe('결제 비밀번호 키패드')
    expect(textOut(r)).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('넘김이 없으면 사용자에게 직접 누르라고 알리고 끝난다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypad)
    const { tools } = build()
    const r = await get(tools, 'fill_secret').handler({
      elementId: 2,
      itemType: 'password',
      provider: 'toss'
    })
    expect(textOut(r)).toBe(`handoff: ${KEYPAD_HANDOFF_MESSAGE}`)
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })
})
