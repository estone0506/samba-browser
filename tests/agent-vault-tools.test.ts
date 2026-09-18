import { describe, it, expect, vi } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { VaultService } from '../src/main/vault/service'
import type { AccountDto, VaultState } from '../src/shared/vault'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부를 수 있게 한다
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
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    fillValue: vi.fn(async () => 'ok'),
    findLoginFields: vi.fn(async () => ({ username: 1, password: 2, submit: 3 })),
    submitForm: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

const PASSWORD = 'sup3r-secret-pw!'

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://www.shop.example/login' } },
  profile: 'default',
  mobile: false
}

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host: 'shop.example',
    label: '메인',
    username: 'hongildong',
    isDefault: false,
    itemTypes: ['login_password'],
    ...over
  }
}

interface Built {
  tools: Map<string, ToolStub>
  confirm: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  getSecretForFill: ReturnType<typeof vi.fn>
  listAccounts: ReturnType<typeof vi.fn>
}

function build(
  opts: {
    mode?: ToolContext['mode']
    state?: VaultState
    accounts?: AccountDto[]
    secret?: string | null
    confirmResult?: boolean
  } = {}
): Built {
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const steps: Array<{ label: string; ok: boolean }> = []
  const listAccounts = vi.fn(() => opts.accounts ?? [account()])
  const getSecretForFill = vi.fn(() => (opts.secret === undefined ? PASSWORD : opts.secret))
  const vault = {
    state: () => opts.state ?? 'unlocked',
    listAccounts,
    getSecretForFill
  } as unknown as VaultService
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
    mode: opts.mode ?? 'guard',
    finalConfirm: false,
    confirm,
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok }),
    vault,
    jobId: 'job-1'
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return {
    tools: new Map(server.tools.map((t) => [t.name, t])),
    confirm,
    steps,
    getSecretForFill,
    listAccounts
  }
}

async function callTool(
  b: Built,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const t = b.tools.get(name)
  if (!t) throw new Error(`도구 없음: ${name}`)
  const r = await t.handler(args)
  return r.content[0].text
}

describe('금고 AI 도구', () => {
  it('등록된다', () => {
    const b = build()
    expect([...b.tools.keys()]).toEqual(
      expect.arrayContaining(['list_accounts', 'fill_secret', 'login'])
    )
  })

  it('read_only 모드에서는 fill_secret·login 을 거부한다', async () => {
    const b = build({ mode: 'read_only' })
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(
      'refused: read-only mode'
    )
    expect(await callTool(b, 'login', {})).toBe('refused: read-only mode')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('잠겨 있으면 잠금 안내를 돌려준다', async () => {
    const b = build({ state: 'locked' })
    const expected = 'locked: ask the user to unlock 개인정보'
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(expected)
    expect(await callTool(b, 'login', {})).toBe(expected)
    expect(b.getSecretForFill).not.toHaveBeenCalled()
  })

  it('guard 모드에서 카드는 확인을 거치고, 거부하면 채우지 않는다', async () => {
    const ok = build()
    expect(await callTool(ok, 'fill_secret', { elementId: 12, itemType: 'card' })).toBe('ok')
    expect(ok.confirm).toHaveBeenCalledWith('개인정보 입력: card', 'danger')
    expect(ok.steps).toContainEqual({ label: '입력: card (#12)', ok: true })

    const denied = build({ confirmResult: false })
    pageBridge.fillValue.mockClear()
    expect(await callTool(denied, 'fill_secret', { elementId: 12, itemType: 'card' })).toBe(
      'denied by user'
    )
    expect(denied.confirm).toHaveBeenCalledOnce()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(denied.getSecretForFill).not.toHaveBeenCalled()
  })

  it('guard 모드라도 로그인 비밀번호는 확인 카드를 띄우지 않는다', async () => {
    const b = build()
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login_password' })).toBe(
      'ok'
    )
    expect(b.confirm).not.toHaveBeenCalled()
  })

  it('login 성공 경로: 비밀번호로 채우지만 결과·step 어디에도 값이 없다', async () => {
    const b = build()
    pageBridge.fillValue.mockClear()
    pageBridge.submitForm.mockClear()
    const result = await callTool(b, 'login', {})

    expect(result).toBe('submitted: check the page for success or captcha/2FA')
    expect(b.getSecretForFill).toHaveBeenCalledWith(1, 'login_password', 'job-1')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(1, fakeTab, 1, 'hongildong')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(2, fakeTab, 2, PASSWORD)
    expect(pageBridge.submitForm).toHaveBeenCalledWith(fakeTab, 3)
    expect(b.steps).toContainEqual({ label: '로그인: shop.example (메인)', ok: true })

    // 방출된 모든 이벤트·결과 문자열에 평문이 섞이지 않았는지 정규식으로 확인한다
    const emitted = JSON.stringify({ result, steps: b.steps })
    expect(emitted).not.toMatch(/sup3r/i)
    expect(emitted).not.toContain(PASSWORD)
  })

  it('로그인 필드가 없으면 안내를 돌려준다', async () => {
    pageBridge.findLoginFields.mockResolvedValueOnce({ username: 1 })
    const b = build()
    expect(await callTool(b, 'login', {})).toBe(
      'fields not found: navigate to the login page first'
    )
  })

  it('계정 선택: 라벨 > 기본 > 유일, 모호하면 안내', async () => {
    const two = [account({ id: 1, label: '개인' }), account({ id: 2, label: '회사' })]

    const byLabel = build({ accounts: two })
    expect(await callTool(byLabel, 'login', { accountLabel: '회사' })).toBe(
      'submitted: check the page for success or captcha/2FA'
    )
    expect(byLabel.getSecretForFill).toHaveBeenCalledWith(2, 'login_password', 'job-1')

    const byDefault = build({
      accounts: [
        account({ id: 1, label: '개인' }),
        account({ id: 2, label: '회사', isDefault: true })
      ]
    })
    expect(await callTool(byDefault, 'login', {})).toBe(
      'submitted: check the page for success or captcha/2FA'
    )
    expect(byDefault.getSecretForFill).toHaveBeenCalledWith(2, 'login_password', 'job-1')

    const ambiguous = build({ accounts: two })
    expect(await callTool(ambiguous, 'login', {})).toBe('account not found: use list_accounts')

    const unknownLabel = build({ accounts: two })
    expect(
      await callTool(unknownLabel, 'fill_secret', {
        elementId: 1,
        itemType: 'card',
        accountLabel: '없음'
      })
    ).toBe('account not found: use list_accounts')
  })

  it('list_accounts 는 사용자명을 마스킹하고 현재 호스트를 쓴다', async () => {
    const b = build()
    const raw = await callTool(b, 'list_accounts', {})
    expect(b.listAccounts).toHaveBeenCalledWith('shop.example')
    expect(JSON.parse(raw)).toEqual([
      { label: '메인', username: 'ho***', types: ['login_password'] }
    ])
    expect(raw).not.toContain('hongildong')
  })

  it('list_accounts 는 host 인자를 우선하고 잠금 상태를 알린다', async () => {
    const b = build({ state: 'locked' })
    const raw = await callTool(b, 'list_accounts', { host: 'other.example' })
    expect(b.listAccounts).toHaveBeenCalledWith('other.example')
    expect(JSON.parse(raw)).toEqual({
      vaultLocked: true,
      accounts: [{ label: '메인', username: 'ho***', types: ['login_password'] }]
    })
  })

  it('저장된 항목이 없으면 값 없이 not found 를 돌려준다', async () => {
    const b = build({ secret: null })
    expect(await callTool(b, 'fill_secret', { elementId: 4, itemType: 'passport' })).toBe(
      'not found: no passport saved for this account'
    )
  })
})
