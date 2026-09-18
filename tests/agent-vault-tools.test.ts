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
    waitForLoad: vi.fn(async () => {}),
    isSecretField: vi.fn(async () => true)
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
    // 호스트를 알 수 없는 상황(정규화 실패)을 재현하기 위한 탭 URL 오버라이드
    tabUrl?: string
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
  const tab =
    opts.tabUrl === undefined
      ? fakeTab
      : { ...fakeTab, view: { webContents: { getURL: () => opts.tabUrl! } } }
  const tabs = {
    active: () => tab,
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

// 방출된 모든 이벤트(step/confirm 호출 인자)와 도구 결과를 한 배열에 모아
// 정규식으로 비밀값이 어디에도 섞이지 않았는지 한 번에 단언하는 헬퍼
function assertNoSecretLeak(b: Built, result: string, secretPattern: RegExp = /sup3r/i): void {
  const emitted = JSON.stringify({
    result,
    steps: b.steps,
    confirmCalls: b.confirm.mock.calls
  })
  expect(emitted).not.toMatch(secretPattern)
  expect(emitted).not.toContain(PASSWORD)
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
    const expected = 'locked: ask the user to unlock 키마스터'
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(expected)
    expect(await callTool(b, 'login', {})).toBe(expected)
    expect(b.getSecretForFill).not.toHaveBeenCalled()
  })

  it('guard 모드에서 카드는 확인을 거치고, 거부하면 채우지 않는다', async () => {
    const ok = build()
    const result = await callTool(ok, 'fill_secret', { elementId: 12, itemType: 'card' })
    expect(result).toBe('ok')
    expect(ok.confirm).toHaveBeenCalledWith('키마스터 입력: card', 'danger')
    expect(ok.steps).toContainEqual({ label: '입력: card (#12)', ok: true })
    assertNoSecretLeak(ok, result)

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

    assertNoSecretLeak(b, result)
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

  it('현재 호스트를 알 수 없으면 전체 계정으로 폴백하지 않는다', async () => {
    const HOST_UNKNOWN = 'host unknown: navigate to the site first'

    const fillSecret = build({ tabUrl: '' })
    const result1 = await callTool(fillSecret, 'fill_secret', { elementId: 5, itemType: 'card' })
    expect(result1).toBe(HOST_UNKNOWN)
    expect(fillSecret.listAccounts).not.toHaveBeenCalled()
    expect(fillSecret.getSecretForFill).not.toHaveBeenCalled()

    pageBridge.findLoginFields.mockClear()
    const login = build({ tabUrl: '' })
    const result2 = await callTool(login, 'login', {})
    expect(result2).toBe(HOST_UNKNOWN)
    expect(login.listAccounts).not.toHaveBeenCalled()
    expect(pageBridge.findLoginFields).not.toHaveBeenCalled()

    const listAccounts = build({ tabUrl: '' })
    const raw = await callTool(listAccounts, 'list_accounts', {})
    expect(JSON.parse(raw)).toEqual({ accounts: [], note: 'host unknown' })
    expect(listAccounts.listAccounts).not.toHaveBeenCalled()
  })

  it('pageBridge.fillValue 실패를 그대로 전달한다(값은 확인되지 않는다)', async () => {
    const b = build()
    pageBridge.fillValue.mockResolvedValueOnce('refused: SECRET field. Ask the user to type it.')
    const result = await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login_password' })
    expect(result).toBe('refused: SECRET field. Ask the user to type it.')
    assertNoSecretLeak(b, result)
  })

  it('login 에서 사용자명 채움 실패는 비밀번호 채움 전에 전파된다', async () => {
    const b = build()
    pageBridge.fillValue.mockClear()
    pageBridge.submitForm.mockClear()
    pageBridge.fillValue.mockResolvedValueOnce('fill failed')
    const result = await callTool(b, 'login', {})
    expect(result).toBe('fill failed')
    expect(pageBridge.fillValue).toHaveBeenCalledTimes(1)
    expect(b.getSecretForFill).toHaveBeenCalled() // 비밀번호는 조회되지만
    expect(pageBridge.submitForm).not.toHaveBeenCalled() // 제출까지 가지 않는다
    assertNoSecretLeak(b, result)
  })

  it('login 에서 비밀번호 채움 실패도 전파된다', async () => {
    const b = build()
    pageBridge.fillValue.mockClear()
    pageBridge.fillValue.mockResolvedValueOnce('ok').mockResolvedValueOnce('fill failed')
    pageBridge.submitForm.mockClear()
    const result = await callTool(b, 'login', {})
    expect(result).toBe('fill failed')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
    assertNoSecretLeak(b, result)
  })

  it('비밀 항목은 대상이 실제 비밀 입력칸(type=password)일 때만 채운다', async () => {
    const b = build()
    pageBridge.fillValue.mockClear()
    pageBridge.isSecretField.mockResolvedValueOnce(false)
    const result = await callTool(b, 'fill_secret', { elementId: 9, itemType: 'login_password' })
    expect(result).toBe('refused: target is not a secret input')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(b.getSecretForFill).not.toHaveBeenCalled()
    expect(b.confirm).not.toHaveBeenCalled()
  })

  it('비밀 입력칸 검사는 passport 등 로그인성이 아닌 항목에는 적용하지 않는다', async () => {
    const b = build()
    pageBridge.isSecretField.mockResolvedValueOnce(false)
    expect(await callTool(b, 'fill_secret', { elementId: 9, itemType: 'passport' })).toBe('ok')
  })

  it('금고가 설정되지 않았으면(uninitialized) 설정 안내를 돌려준다', async () => {
    const NOT_SET_UP = 'not set up: ask the user to set up 키마스터 first'

    const fillSecret = build({ state: 'uninitialized' })
    expect(await callTool(fillSecret, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(
      NOT_SET_UP
    )

    const login = build({ state: 'uninitialized' })
    expect(await callTool(login, 'login', {})).toBe(NOT_SET_UP)
    expect(login.getSecretForFill).not.toHaveBeenCalled()

    const listAccounts = build({ state: 'uninitialized' })
    const raw = await callTool(listAccounts, 'list_accounts', {})
    expect(JSON.parse(raw)).toEqual({ accounts: [], note: NOT_SET_UP })
  })
})
