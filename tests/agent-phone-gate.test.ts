import { describe, it, expect, vi } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { PhoneDto } from '../src/shared/phone'
import type { PhoneToolContext } from '../src/main/agent/tools-phone'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 목록을 직접 들여다본다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    snapshot: vi.fn(),
    keypadSignals: vi.fn(async () => ({ url: '', text: '', digitButtons: 0, pinField: false }))
  }
}))

const { createSambaTools } = await import('../src/main/agent/tools')
const { hasConnectedPhone, PHONE_TOOL_NAMES } = await import('../src/main/agent/tools-phone')
const { buildSystemPrompt, NO_PHONE_LINE } = await import('../src/main/agent/prompt')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

function fakePhone(state: PhoneDto['state']): PhoneDto {
  return {
    id: 1,
    serial: 'R3CRA05HY3R',
    label: '폰1',
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM-A536N',
    state,
    smsQueryOk: true,
    lastSeenAt: 0,
    screenMode: null
  }
}

/** 폰 도구 문맥 — 목록만 바꿔 가며 노출 여부를 본다 */
function phoneCtx(list: PhoneDto[]): PhoneToolContext {
  const notCalled = (): never => {
    throw new Error('이 테스트에서는 폰 조작을 부르지 않는다')
  }
  return {
    phones: {
      list: () => list,
      screen: notCalled,
      tap: notCalled,
      swipe: notCalled,
      typeText: notCalled,
      key: notCalled,
      screenshot: notCalled,
      isSecret: () => false
    },
    mode: 'guard',
    assigned: () => null,
    confirm: async () => true,
    tick: () => null,
    onStep: () => {}
  }
}

function toolNames(phones?: PhoneDto[]): string[] {
  const tabs = {
    active: () => null,
    list: () => [],
    create: vi.fn(),
    activate: vi.fn(),
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'guard',
    finalConfirm: false,
    confirm: async () => true,
    tick: () => null,
    onStep: () => {},
    ...(phones === undefined ? {} : { phone: phoneCtx(phones) })
  }
  const server = createSambaTools(ctx) as unknown as { tools: { name: string }[] }
  return server.tools.map((t) => t.name)
}

describe('hasConnectedPhone', () => {
  it('online 인 폰이 하나라도 있으면 true', () => {
    expect(hasConnectedPhone(phoneCtx([fakePhone('online')]))).toBe(true)
  })
  it('목록이 비었거나 전부 offline 이면 false', () => {
    expect(hasConnectedPhone(phoneCtx([]))).toBe(false)
    expect(hasConnectedPhone(phoneCtx([fakePhone('offline')]))).toBe(false)
  })
})

describe('폰 도구 조건부 노출', () => {
  it('연결된 폰이 0대면 도구 목록에 phone_* 이 없다', () => {
    const names = toolNames([])
    for (const n of PHONE_TOOL_NAMES) expect(names).not.toContain(n)
    // 웹 도구는 그대로 있다
    expect(names).toContain('get_page')
    expect(names).toContain('run_js')
  })

  it('폰 배선 자체가 없어도 phone_* 이 없다', () => {
    expect(toolNames()).not.toContain('phone_tap')
  })

  it('폰이 붙어 있으면 다시 노출된다', () => {
    const names = toolNames([fakePhone('online')])
    for (const n of PHONE_TOOL_NAMES) expect(names).toContain(n)
  })
})

describe('시스템 프롬프트', () => {
  it('폰이 없으면 폰 절이 한 줄로 줄어든다', () => {
    const p = buildSystemPrompt('ko', 'guard', 'medium', false)
    expect(p).toContain(NO_PHONE_LINE)
    expect(p).not.toContain('phone_tap')
  })

  it('폰이 있으면 폰 절이 그대로 들어간다', () => {
    const p = buildSystemPrompt('ko', 'guard', 'medium', true)
    expect(p).toContain('phone_tap')
    expect(p).not.toContain(NO_PHONE_LINE)
  })

  it('기본값은 폰 없음이다(배선하지 않은 호출부)', () => {
    expect(buildSystemPrompt('ko', 'guard')).toContain(NO_PHONE_LINE)
  })

  it('도구 사용 원칙이 맨 앞에서 run_js 를 먼저 권한다', () => {
    const p = buildSystemPrompt('ko', 'guard', 'medium', true)
    expect(p).toContain('TOOL USE PRINCIPLES')
    expect(p).toContain('ONE run_js call')
    expect(p.indexOf('TOOL USE PRINCIPLES')).toBeLessThan(p.indexOf('RULES'))
    // id 가 안정적이라는 사실도 알려 준다
    expect(p).toContain('Element ids are stable')
  })
})

describe('도구 설명', () => {
  const describedBy = (name: string): string => {
    const tabs = {
      active: () => null,
      list: () => [],
      create: vi.fn(),
      activate: vi.fn(),
      navigate: vi.fn(async () => {})
    } as unknown as TabManager
    const ctx: ToolContext = {
      tabs,
      dangerWords: DEFAULT_DANGER_WORDS,
      mode: 'guard',
      finalConfirm: false,
      confirm: async () => true,
      tick: () => null,
      onStep: () => {}
    }
    const server = createSambaTools(ctx) as unknown as {
      tools: { name: string; description: string }[]
    }
    return server.tools.find((t) => t.name === name)!.description
  }

  it('click·get_page 는 첫 문장에서 run_js 를 권한다', () => {
    expect(describedBy('click')).toMatch(/^For single actions; prefer run_js for sequences\./)
    expect(describedBy('get_page')).toMatch(/^For single actions; prefer run_js for sequences\./)
  })

  it('screenshot 은 텍스트로 판단되면 쓰지 말라고 말한다', () => {
    expect(describedBy('screenshot')).toContain('Do NOT use it when the text snapshot already')
  })
})
