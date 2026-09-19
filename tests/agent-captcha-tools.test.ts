import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { HandoffResult } from '../src/main/agent/handoff'

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
    waitForLoad: vi.fn(async () => {}),
    findLoginFields: vi.fn(),
    signedInHint: vi.fn(async () => ({ signedIn: false, matched: '' })),
    captchaHint: vi.fn(async () => ({ needsUser: false, matched: '' })),
    checkKeepSignedIn: vi.fn(async () => 'checked: 로그인 상태 유지'),
    fillValue: vi.fn(async () => 'ok'),
    submitForm: vi.fn(async () => 'ok'),
    isSecretField: vi.fn(async () => true)
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://shop.example/login' } },
  profile: 'default',
  mobile: false
}

// 금고 스텁 — 계정 1개와 비밀번호가 있는 상태
const vault = {
  state: () => 'unlocked',
  listAccounts: () => [
    {
      id: 'a1',
      label: '기본',
      username: 'user@example.com',
      host: 'shop.example',
      isDefault: true,
      itemTypes: ['login'],
      tags: [],
      agentAccess: 'inherit'
    }
  ],
  getSecretForFill: () => 'pw',
  ensureUnlockedByDevice: async () => {}
}

function build(
  opts: {
    handoff?: (req: {
      matched: string
      currentUrl: () => string
      stillBlocked: () => Promise<boolean>
    }) => Promise<HandoffResult>
    vaultKeepSignedIn?: boolean
  } = {}
): { tools: Record<string, ToolStub>; steps: Array<{ label: string; ok: boolean }> } {
  const steps: Array<{ label: string; ok: boolean }> = []
  const tabs = {
    active: () => fakeTab,
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: (label: string, ok: boolean) => steps.push({ label, ok }),
    vault,
    vaultKeepSignedIn: opts.vaultKeepSignedIn,
    handoff: opts.handoff
  } as unknown as ToolContext
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  const tools: Record<string, ToolStub> = {}
  for (const t of server.tools) tools[t.name] = t
  return { tools, steps }
}

const run = async (t: ToolStub, args: Record<string, unknown> = {}): Promise<string> =>
  (await t.handler(args)).content[0].text

const NO_FIELDS = { stage: 'none' as const, confidence: 0, iframe: false }
const FULL_FORM = {
  stage: 'single' as const,
  username: 1,
  password: 2,
  submit: 3,
  confidence: 0.9,
  iframe: false
}

beforeEach(() => {
  pageBridge.findLoginFields.mockReset()
  pageBridge.signedInHint.mockReset()
  pageBridge.signedInHint.mockResolvedValue({ signedIn: false, matched: '' })
  pageBridge.captchaHint.mockReset()
  pageBridge.captchaHint.mockResolvedValue({ needsUser: false, matched: '' })
  pageBridge.checkKeepSignedIn.mockClear()
  pageBridge.submitForm.mockClear()
  pageBridge.submitForm.mockResolvedValue('ok')
})

describe('login — 이미 로그인된 상태면 다시 로그인하지 않는다', () => {
  it('폼이 없고 로그아웃 링크가 있으면 already signed in', async () => {
    pageBridge.findLoginFields.mockResolvedValue(NO_FIELDS)
    pageBridge.signedInHint.mockResolvedValue({ signedIn: true, matched: '로그아웃' })
    const { tools, steps } = build()
    const r = await run(tools.login)
    expect(r).toBe('already signed in (로그아웃)')
    // 비밀번호를 채우거나 제출하지 않는다
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
    expect(steps.at(-1)?.label).toMatch(/이미 로그인됨/)
  })

  it('로그인 폼이 있으면 상태 힌트를 보지 않는다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    const { tools } = build()
    await run(tools.login)
    expect(pageBridge.signedInHint).not.toHaveBeenCalled()
    expect(pageBridge.submitForm).toHaveBeenCalled()
  })

  it('힌트가 아니면 평소대로 로그인한다', async () => {
    pageBridge.findLoginFields.mockResolvedValueOnce(NO_FIELDS).mockResolvedValue(NO_FIELDS)
    pageBridge.signedInHint.mockResolvedValue({ signedIn: false, matched: '' })
    const { tools } = build()
    expect(await run(tools.login)).toMatch(/fields not found/)
  })
})

describe('login — 로그인 상태 유지 자동 체크', () => {
  it('제출 직전에 체크박스를 켠다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    const { tools } = build()
    await run(tools.login)
    expect(pageBridge.checkKeepSignedIn).toHaveBeenCalledWith(fakeTab, 3)
    // 체크가 제출보다 먼저 일어나야 한다
    expect(pageBridge.checkKeepSignedIn.mock.invocationCallOrder[0]).toBeLessThan(
      pageBridge.submitForm.mock.invocationCallOrder[0]
    )
  })

  it('설정이 꺼져 있으면 건드리지 않는다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    const { tools } = build({ vaultKeepSignedIn: false })
    await run(tools.login)
    expect(pageBridge.checkKeepSignedIn).not.toHaveBeenCalled()
  })

  it('체크박스 조작이 실패해도 로그인은 계속한다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    pageBridge.checkKeepSignedIn.mockRejectedValueOnce(new Error('page is gone'))
    const { tools } = build()
    expect(await run(tools.login)).toMatch(/submitted/)
  })
})

describe('login — 캡차·2FA 사용자 넘김', () => {
  it('넘김 콜백이 있으면 결과를 기다렸다가 재개 문구를 돌려준다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    pageBridge.captchaHint.mockResolvedValue({ needsUser: true, matched: '캡차' })
    const handoff = vi.fn(async () => ({
      outcome: 'resumed' as const,
      url: 'https://shop.example/mypage'
    }))
    const { tools } = build({ handoff })
    const r = await run(tools.login)
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(handoff.mock.calls[0][0].matched).toBe('캡차')
    expect(r).toBe('user completed the check; page changed to https://shop.example/mypage')
  })

  it('넘김 콜백이 없으면 needs_user 문자열만 돌려준다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    pageBridge.captchaHint.mockResolvedValue({ needsUser: true, matched: 'captcha' })
    const { tools } = build()
    expect(await run(tools.login)).toMatch(/^needs_user: captcha \(captcha\)/)
  })

  it('징후가 없으면 넘김하지 않는다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    const handoff = vi.fn(async () => ({ outcome: 'skipped' as const, url: '' }))
    const { tools } = build({ handoff })
    expect(await run(tools.login)).toMatch(/^submitted/)
    expect(handoff).not.toHaveBeenCalled()
  })
})

// 3차 리뷰 I5 — 읽기 도구는 넘김을 **시작하지 않는다**.
// get_page 가 넘김을 걸면 화면을 한 번 읽어 보려던 호출이 최장 10분 막힌다
describe('get_page — 캡차 징후는 알리기만 하고 기다리지 않는다', () => {
  it('넘김을 시작하지 않고 안내와 화면을 함께 돌려준다', async () => {
    pageBridge.captchaHint.mockResolvedValue({ needsUser: true, matched: 'captcha frame' })
    const handoff = vi.fn(async () => ({
      outcome: 'resumed' as const,
      url: 'https://shop.example/home'
    }))
    const { tools } = build({ handoff })
    const r = await run(tools.get_page)
    expect(r).toMatch(/^needs_user: captcha \(captcha frame\)/)
    expect(r).toContain('URL: https://shop.example/')
    expect(handoff).not.toHaveBeenCalled()
    // 넘김이 없으니 화면도 한 번만 읽는다
    expect(pageBridge.snapshot).toHaveBeenCalledTimes(1)
  })

  it('징후가 없으면 평소처럼 화면만 돌려준다', async () => {
    const handoff = vi.fn(async () => ({ outcome: 'skipped' as const, url: '' }))
    const { tools } = build({ handoff })
    const r = await run(tools.get_page)
    expect(r).not.toMatch(/needs_user/)
    expect(handoff).not.toHaveBeenCalled()
  })
})

// 3차 리뷰 I5 — 감시 중에 탭이 사라지면 currentUrl 이 던진다.
// 그대로 전파하면 도구 호출 전체가 예외로 끝나 모델이 아무 정보도 받지 못한다
describe('넘김 도중 탭이 사라지면 넘김만 접는다', () => {
  it('login 이 예외로 끝나지 않고 취소 안내를 돌려준다', async () => {
    pageBridge.findLoginFields.mockResolvedValue(FULL_FORM)
    pageBridge.captchaHint.mockResolvedValue({ needsUser: true, matched: 'captcha' })
    const handoff = vi.fn(async () => {
      throw new Error('Object has been destroyed')
    })
    const { tools } = build({ handoff })
    const r = await run(tools.login)
    expect(handoff).toHaveBeenCalled()
    expect(r).toMatch(/handoff was cancelled/)
  })
})
