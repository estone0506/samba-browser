import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const { createSambaTools, isSecurePageUrl } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

const PASSWORD = 'sup3r-secret-pw!'

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const DEFAULT_TAB_URL = 'https://www.shop.example/login'

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host: 'shop.example',
    label: '메인',
    username: 'hongildong',
    isDefault: false,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: [],
    ...over
  }
}

interface Built {
  tools: Map<string, ToolStub>
  confirm: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  getSecretForFill: ReturnType<typeof vi.fn>
  getPaymentSecretForFill: ReturnType<typeof vi.fn>
  listAccounts: ReturnType<typeof vi.fn>
  ensureUnlockedByDevice: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  // 도구가 보는 탭 객체(fillValue 인자 대조용)
  tab: { id: string; profile: string; mobile: boolean }
  // 테스트 도중 페이지가 다른 주소로 옮겨 간 상황을 재현한다
  setUrl: (url: string) => void
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
    // 탭 프로필(계정 순회에서 계정 자동 선택에 쓰인다)
    tabProfile?: string
    vaultAccessPolicy?: ToolContext['vaultAccessPolicy']
    vaultAutoSubmit?: ToolContext['vaultAutoSubmit']
    vaultExcludedHosts?: ToolContext['vaultExcludedHosts']
    // ensureUnlockedByDevice 호출 시 상태가 바뀌는지(자동 해제 성공 시뮬레이션)
    deviceUnlockSucceeds?: boolean
    // 결제 비밀번호 조회 결과(계정에 여러 개일 때 'ambiguous' 를 재현한다)
    payment?: { value: string | null; reason?: 'not-found' | 'ambiguous' }
  } = {}
): Built {
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const steps: Array<{ label: string; ok: boolean }> = []
  const listAccounts = vi.fn(() => opts.accounts ?? [account()])
  const getSecretForFill = vi.fn(() => (opts.secret === undefined ? PASSWORD : opts.secret))
  const getPaymentSecretForFill = vi.fn(() => opts.payment ?? { value: PASSWORD })
  let currentState = opts.state ?? 'unlocked'
  const ensureUnlockedByDevice = vi.fn(async () => {
    if (opts.deviceUnlockSucceeds) currentState = 'unlocked'
    return currentState === 'unlocked'
  })
  const vault = {
    state: () => currentState,
    listAccounts,
    getSecretForFill,
    getPaymentSecretForFill,
    ensureUnlockedByDevice
  } as unknown as VaultService
  // 탭 URL 은 이동·리다이렉트로 바뀔 수 있으므로 클로저로 읽는다
  let tabUrl = opts.tabUrl ?? DEFAULT_TAB_URL
  const setUrl = (url: string): void => {
    tabUrl = url
  }
  const tab = {
    id: 't1',
    view: { webContents: { getURL: (): string => tabUrl } },
    profile: opts.tabProfile ?? 'default',
    mobile: false
  }
  // 이동하면 실제처럼 탭 URL 도 따라 바뀐다
  const navigate = vi.fn(async (_id: string, to: string) => {
    setUrl(to)
  })
  const tabs = {
    active: () => tab,
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate
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
    jobId: 'job-1',
    vaultAccessPolicy: opts.vaultAccessPolicy,
    vaultAutoSubmit: opts.vaultAutoSubmit,
    vaultExcludedHosts: opts.vaultExcludedHosts
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return {
    tools: new Map(server.tools.map((t) => [t.name, t])),
    confirm,
    steps,
    getSecretForFill,
    getPaymentSecretForFill,
    listAccounts,
    ensureUnlockedByDevice,
    navigate,
    tab,
    setUrl
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

// 폴백 경로 검증이 mock 호출 순서를 보므로 페이지 관련 mock 은 테스트마다 기본값으로 되돌린다
beforeEach(() => {
  pageBridge.findLoginFields.mockReset()
  pageBridge.findLoginFields.mockResolvedValue({ username: 1, password: 2, submit: 3 })
  pageBridge.snapshot.mockReset()
  pageBridge.click.mockClear()
  pageBridge.fillValue.mockClear()
  pageBridge.submitForm.mockClear()
})

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

  it('결제 비밀번호는 고른 결제 수단(provider)으로 조회한다', async () => {
    const b = build()
    const result = await callTool(b, 'fill_secret', {
      elementId: 4,
      itemType: 'password',
      provider: 'toss'
    })

    expect(result).toBe('ok')
    expect(b.getPaymentSecretForFill).toHaveBeenCalledWith({
      accountId: 1,
      provider: 'toss',
      fieldKey: 'value',
      jobId: 'job-1'
    })
    expect(b.getSecretForFill).not.toHaveBeenCalled()
    assertNoSecretLeak(b, result)
  })

  it('결제 수단을 안 줬는데 계정에 여러 개면 채우지 않고 지정을 요구한다', async () => {
    const b = build({ payment: { value: null, reason: 'ambiguous' } })
    pageBridge.fillValue.mockClear()
    const result = await callTool(b, 'fill_secret', { elementId: 4, itemType: 'password' })

    expect(result).toMatch(/^ambiguous: /)
    // 결제 수단 목록을 안내해 모델이 되묻거나 골라 다시 부르게 한다
    expect(result).toContain('toss')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    assertNoSecretLeak(b, result)
  })

  it('그 결제 수단이 저장돼 있지 않으면 not found 를 돌려준다', async () => {
    const b = build({ payment: { value: null, reason: 'not-found' } })
    pageBridge.fillValue.mockClear()
    const result = await callTool(b, 'fill_secret', {
      elementId: 4,
      itemType: 'password',
      provider: 'kakao'
    })

    expect(result).toBe('not found: no payment password (kakao) saved for this account')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('guard 모드라도 로그인 비밀번호는 확인 카드를 띄우지 않는다', async () => {
    const b = build()
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })).toBe('ok')
    expect(b.confirm).not.toHaveBeenCalled()
  })

  it('login 성공 경로: 비밀번호로 채우지만 결과·step 어디에도 값이 없다', async () => {
    const b = build()
    pageBridge.fillValue.mockClear()
    pageBridge.submitForm.mockClear()
    const result = await callTool(b, 'login', {})

    expect(result).toBe('submitted: check the page for success or captcha/2FA')
    expect(b.getSecretForFill).toHaveBeenCalledWith(1, 'login', 'value', 'job-1')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(1, b.tab, 1, 'hongildong')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(2, b.tab, 2, PASSWORD)
    expect(pageBridge.submitForm).toHaveBeenCalledWith(b.tab, 3)
    expect(b.steps).toContainEqual({ label: '로그인: shop.example (메인)', ok: true })

    assertNoSecretLeak(b, result)
  })

  it('탭이 naver.com(www. 제거)이고 계정이 nid.naver.com 에 저장돼 있어도 login 이 성공한다(도메인 매칭 실검수 회귀)', async () => {
    const naverAccount = account({
      id: 7,
      host: 'nid.naver.com',
      label: '네이버',
      username: 'naveruser',
      isDefault: true
    })
    const b = build({
      tabUrl: 'https://www.naver.com/',
      accounts: [naverAccount]
    })
    pageBridge.fillValue.mockClear()
    pageBridge.submitForm.mockClear()
    const result = await callTool(b, 'login', {})

    expect(result).toBe('submitted: check the page for success or captcha/2FA')
    expect(b.getSecretForFill).toHaveBeenCalledWith(7, 'login', 'value', 'job-1')
    assertNoSecretLeak(b, result)
  })

  it('로그인 필드가 없으면 안내를 돌려준다', async () => {
    pageBridge.findLoginFields.mockResolvedValueOnce({ username: 1 })
    const b = build()
    expect(await callTool(b, 'login', {})).toBe(
      'fields not found: navigate to the login page first'
    )
  })

  describe('로그인 폼 폴백', () => {
    const FORM = { username: 1, password: 2, submit: 3, stage: 'single' }
    const NO_FORM = { stage: 'none' }

    it('폼이 없으면 알려진 로그인 URL 로 옮겨 가 다시 찾는다', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce(NO_FORM).mockResolvedValueOnce(FORM)
      const b = build({
        tabUrl: 'https://www.musinsa.com/member/join',
        accounts: [account({ host: 'musinsa.com' })]
      })

      expect(await callTool(b, 'login', {})).toBe(
        'submitted: check the page for success or captcha/2FA'
      )
      expect(b.navigate).toHaveBeenCalledWith('t1', 'https://www.musinsa.com/auth/login')
      expect(pageBridge.click).not.toHaveBeenCalled()
    })

    it('알려진 URL 이 없으면 페이지의 로그인 링크를 눌러 다시 찾는다', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce(NO_FORM).mockResolvedValueOnce(FORM)
      pageBridge.snapshot.mockResolvedValueOnce({
        url: 'https://www.shop.example/',
        title: '',
        text: '',
        elements: [
          { id: 4, tag: 'a', role: 'link', text: '고객센터', isSecret: false },
          { id: 9, tag: 'a', role: 'link', text: '로그인', href: '/member/login', isSecret: false }
        ]
      })
      const b = build({ tabUrl: 'https://www.shop.example/' })

      expect(await callTool(b, 'login', {})).toBe(
        'submitted: check the page for success or captcha/2FA'
      )
      expect(b.navigate).not.toHaveBeenCalled()
      expect(pageBridge.click).toHaveBeenCalledWith(expect.anything(), 9)
    })

    it('링크 클릭으로 다른 등록 도메인으로 넘어가면 그 도메인의 계정으로 다시 고른다(통합 로그인)', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce(NO_FORM).mockResolvedValueOnce(FORM)
      const b = build({
        tabUrl: 'https://www.29cm.co.kr/',
        accounts: [account({ id: 11, host: 'musinsa.com', label: '무신사' })]
      })
      // 29cm 로그인 페이지가 무신사 통합 로그인으로 리다이렉트된 상황
      pageBridge.waitForLoad.mockImplementationOnce(async () => {
        b.setUrl('https://www.musinsa.com/auth/login')
      })

      expect(await callTool(b, 'login', {})).toBe(
        'submitted: check the page for success or captcha/2FA'
      )
      // 옮겨 간 도메인으로 계정을 다시 조회했다
      expect(b.listAccounts).toHaveBeenLastCalledWith('musinsa.com')
      expect(b.getSecretForFill).toHaveBeenCalledWith(11, 'login', 'value', 'job-1')
      expect(b.steps).toContainEqual({ label: '로그인: musinsa.com (무신사)', ok: true })
    })

    it('옮겨 간 도메인에 저장된 계정이 없으면 원래 계정을 쓰지 않고 거부한다', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce(NO_FORM).mockResolvedValueOnce(FORM)
      const b = build({ tabUrl: 'https://www.29cm.co.kr/', accounts: [] })
      pageBridge.waitForLoad.mockImplementationOnce(async () => {
        b.setUrl('https://www.musinsa.com/auth/login')
      })

      expect(await callTool(b, 'login', {})).toBe('account not found: use list_accounts')
      expect(pageBridge.fillValue).not.toHaveBeenCalled()
    })

    it('채우기 직전에 다른 등록 도메인으로 튕기면 비밀번호를 채우지 않는다', async () => {
      const b = build({ tabUrl: 'https://www.shop.example/login' })
      // 아이디를 채운 직후 전혀 다른 사이트로 리다이렉트된 상황
      pageBridge.fillValue.mockImplementationOnce(async () => {
        b.setUrl('https://phishing.example.net/login')
        return 'ok'
      })

      expect(await callTool(b, 'login', {})).toBe(
        'refused: HOST_MISMATCH — page moved to another domain'
      )
      expect(pageBridge.fillValue).toHaveBeenCalledTimes(1)
      expect(pageBridge.submitForm).not.toHaveBeenCalled()
    })

    it('채우기 직전에 평문(http) 페이지로 내려서면 비밀번호를 채우지 않는다', async () => {
      const b = build({ tabUrl: 'https://www.shop.example/login' })
      pageBridge.fillValue.mockImplementationOnce(async () => {
        b.setUrl('http://www.shop.example/login')
        return 'ok'
      })

      expect(await callTool(b, 'login', {})).toBe('refused: insecure page (https required)')
      expect(pageBridge.fillValue).toHaveBeenCalledTimes(1)
    })

    it('2단계 로그인: 아이디 제출 뒤 다른 등록 도메인이면 비밀번호 단계를 중단한다', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce({
        username: 1,
        submit: 3,
        stage: 'username-only'
      })
      const b = build({ tabUrl: 'https://www.shop.example/login' })
      // 아이디 제출 후 다른 사이트로 넘어간다
      pageBridge.submitForm.mockImplementationOnce(async () => {
        b.setUrl('https://evil.example.net/step2')
        return 'ok'
      })

      expect(await callTool(b, 'login', {})).toBe(
        'refused: HOST_MISMATCH — page moved to another domain'
      )
      // 2단계 폼 재탐지까지 가지 않는다
      expect(pageBridge.findLoginFields).toHaveBeenCalledTimes(1)
      expect(b.getSecretForFill).not.toHaveBeenCalled()
    })

    it('2단계 로그인: 아이디 제출 뒤 평문 페이지면 중단한다', async () => {
      pageBridge.findLoginFields.mockResolvedValueOnce({
        username: 1,
        submit: 3,
        stage: 'username-only'
      })
      const b = build({ tabUrl: 'https://www.shop.example/login' })
      pageBridge.submitForm.mockImplementationOnce(async () => {
        b.setUrl('http://www.shop.example/step2')
        return 'ok'
      })

      expect(await callTool(b, 'login', {})).toBe('refused: insecure page (https required)')
      expect(b.getSecretForFill).not.toHaveBeenCalled()
    })

    it('2단계 로그인: 같은 등록 도메인의 다른 서브도메인으로 넘어가면 계속 진행한다', async () => {
      pageBridge.findLoginFields
        .mockResolvedValueOnce({ username: 1, submit: 3, stage: 'username-only' })
        .mockResolvedValueOnce(FORM)
      const b = build({
        tabUrl: 'https://nid.naver.com/login',
        accounts: [account({ id: 7, host: 'nid.naver.com', label: '네이버' })]
      })
      pageBridge.submitForm.mockImplementationOnce(async () => {
        b.setUrl('https://nid.naver.com/login/step2')
        return 'ok'
      })

      expect(await callTool(b, 'login', {})).toBe(
        'submitted: check the page for success or captcha/2FA'
      )
      expect(b.getSecretForFill).toHaveBeenCalledWith(7, 'login', 'value', 'job-1')
    })

    it('폴백을 모두 시도해도 못 찾으면 안내를 돌려준다', async () => {
      pageBridge.findLoginFields.mockResolvedValue(NO_FORM)
      pageBridge.snapshot.mockResolvedValue({
        url: 'https://www.shop.example/',
        title: '',
        text: '',
        elements: []
      })
      const b = build({ tabUrl: 'https://www.shop.example/' })

      expect(await callTool(b, 'login', {})).toBe(
        'fields not found: navigate to the login page first'
      )
      expect(pageBridge.fillValue).not.toHaveBeenCalled()
    })
  })

  it('계정 선택: 라벨 > 기본 > 유일, 모호하면 안내', async () => {
    const two = [account({ id: 1, label: '개인' }), account({ id: 2, label: '회사' })]

    const byLabel = build({ accounts: two })
    expect(await callTool(byLabel, 'login', { accountLabel: '회사' })).toBe(
      'submitted: check the page for success or captcha/2FA'
    )
    expect(byLabel.getSecretForFill).toHaveBeenCalledWith(2, 'login', 'value', 'job-1')

    const byDefault = build({
      accounts: [
        account({ id: 1, label: '개인' }),
        account({ id: 2, label: '회사', isDefault: true })
      ]
    })
    expect(await callTool(byDefault, 'login', {})).toBe(
      'submitted: check the page for success or captcha/2FA'
    )
    expect(byDefault.getSecretForFill).toHaveBeenCalledWith(2, 'login', 'value', 'job-1')

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
      { label: '메인', username: 'ho***', types: ['login'], tags: [] }
    ])
    expect(raw).not.toContain('hongildong')
  })

  it('list_accounts 는 현재 호스트와 같은 host 인자를 받아들이고 잠금 상태를 알린다', async () => {
    const b = build({ state: 'locked' })
    const raw = await callTool(b, 'list_accounts', { host: 'www.shop.example' })
    expect(b.listAccounts).toHaveBeenCalledWith('shop.example')
    expect(JSON.parse(raw)).toEqual({
      vaultLocked: true,
      accounts: [{ label: '메인', username: 'ho***', types: ['login'], tags: [] }]
    })
  })

  it('list_accounts 는 현재 탭과 다른 host 인자를 거부한다(계정 열거 방지)', async () => {
    const b = build()
    const raw = await callTool(b, 'list_accounts', { host: 'other.example' })
    expect(JSON.parse(raw)).toEqual({
      accounts: [],
      note: 'refused: host must match the current tab'
    })
    expect(b.listAccounts).not.toHaveBeenCalled()
  })

  it('list_accounts 는 접근 정책 never 면 즉시 거부한다', async () => {
    const b = build({ vaultAccessPolicy: 'never' })
    const raw = await callTool(b, 'list_accounts', {})
    expect(raw).toBe('refused: KeyMaster access policy is Never')
    expect(b.listAccounts).not.toHaveBeenCalled()
  })

  it('list_accounts 는 제외 도메인이면 계정 목록을 노출하지 않는다', async () => {
    const b = build({ vaultExcludedHosts: ['shop.example'] })
    const raw = await callTool(b, 'list_accounts', {})
    expect(raw).toBe('refused: host excluded')
    expect(b.listAccounts).not.toHaveBeenCalled()
  })

  it('저장된 항목이 없으면 값 없이 not found 를 돌려준다', async () => {
    const b = build({ secret: null })
    expect(await callTool(b, 'fill_secret', { elementId: 4, itemType: 'identity' })).toBe(
      'not found: no identity.value saved for this account'
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
    const result = await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })
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
    const result = await callTool(b, 'fill_secret', { elementId: 9, itemType: 'login' })
    expect(result).toBe('refused: target is not a secret input')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(b.getSecretForFill).not.toHaveBeenCalled()
    expect(b.confirm).not.toHaveBeenCalled()
  })

  it('비밀 입력칸 검사는 passport 등 로그인성이 아닌 항목에는 적용하지 않는다', async () => {
    const b = build()
    pageBridge.isSecretField.mockResolvedValueOnce(false)
    expect(await callTool(b, 'fill_secret', { elementId: 9, itemType: 'identity' })).toBe('ok')
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

  it('접근 정책 never: fill_secret·login 을 즉시 거부한다', async () => {
    const NEVER = 'refused: KeyMaster access policy is Never'
    const b = build({ vaultAccessPolicy: 'never' })
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(NEVER)
    expect(await callTool(b, 'login', {})).toBe(NEVER)
    expect(b.getSecretForFill).not.toHaveBeenCalled()
  })

  it('접근 정책 always: 잠겨 있어도 기기 키로 자동 해제를 시도한 뒤 진행한다', async () => {
    // 이전 테스트가 mockResolvedValueOnce(false) 를 큐에 남겨 뒀을 수 있어 명시적으로 되돌린다
    pageBridge.isSecretField.mockReset()
    pageBridge.isSecretField.mockImplementation(async () => true)
    const b = build({
      vaultAccessPolicy: 'always',
      state: 'locked',
      deviceUnlockSucceeds: true
    })
    const result = await callTool(b, 'fill_secret', { elementId: 12, itemType: 'card' })
    expect(result).toBe('ok')
    expect(b.ensureUnlockedByDevice).toHaveBeenCalled()
  })

  it('접근 정책 always 라도 기기 자동 해제가 계속 실패하면 잠금 안내를 돌려준다', async () => {
    const b = build({
      vaultAccessPolicy: 'always',
      state: 'locked',
      deviceUnlockSucceeds: false
    })
    const result = await callTool(b, 'fill_secret', { elementId: 12, itemType: 'card' })
    expect(result).toBe('locked: ask the user to unlock 키마스터')
    expect(b.ensureUnlockedByDevice).toHaveBeenCalledTimes(1)
  })

  it('vaultAutoSubmit=false 이면 login 은 채우기만 하고 제출하지 않는다', async () => {
    const b = build({ vaultAutoSubmit: false })
    pageBridge.submitForm.mockClear()
    const result = await callTool(b, 'login', {})
    expect(result).toBe('filled: submit is disabled by setting; ask the user to press login')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
    assertNoSecretLeak(b, result)
  })

  it('제외 도메인이면 fill_secret·login 모두 건너뛴다', async () => {
    const EXCLUDED = 'refused: host is excluded from KeyMaster'
    const b = build({ vaultExcludedHosts: ['shop.example'] })
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'card' })).toBe(EXCLUDED)
    expect(await callTool(b, 'login', {})).toBe(EXCLUDED)
    expect(b.listAccounts).not.toHaveBeenCalled()
    expect(b.getSecretForFill).not.toHaveBeenCalled()
  })
  it('http:// 페이지에서는 fill_secret·login 을 거부한다', async () => {
    const INSECURE = 'refused: insecure page (https required)'

    const fill = build({ tabUrl: 'http://shop.example/login' })
    pageBridge.fillValue.mockClear()
    expect(await callTool(fill, 'fill_secret', { elementId: 5, itemType: 'login' })).toBe(INSECURE)
    expect(fill.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()

    pageBridge.findLoginFields.mockClear()
    const login = build({ tabUrl: 'http://shop.example/login' })
    expect(await callTool(login, 'login', {})).toBe(INSECURE)
    expect(login.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.findLoginFields).not.toHaveBeenCalled()
  })

  it('http://localhost 는 개발 편의를 위해 허용한다', async () => {
    pageBridge.isSecretField.mockReset()
    pageBridge.isSecretField.mockImplementation(async () => true)
    const b = build({
      tabUrl: 'http://localhost:5173/login',
      accounts: [account({ host: 'localhost' })]
    })
    expect(await callTool(b, 'fill_secret', { elementId: 5, itemType: 'login' })).toBe('ok')
  })
})

describe('isSecurePageUrl', () => {
  it('https 와 로컬 http 만 허용한다', () => {
    expect(isSecurePageUrl('https://shop.example/login')).toBe(true)
    expect(isSecurePageUrl('http://localhost:3000/')).toBe(true)
    expect(isSecurePageUrl('http://127.0.0.1/')).toBe(true)
    expect(isSecurePageUrl('http://shop.example/login')).toBe(false)
    expect(isSecurePageUrl('file:///c:/tmp/login.html')).toBe(false)
    expect(isSecurePageUrl('about:blank')).toBe(false)
    expect(isSecurePageUrl('')).toBe(false)
  })
})

// --- Task 11: field 인자 · 항목별 agentAccess · 계정 순회 -------------------

describe('fill_secret 의 field 인자', () => {
  it('field 를 생략하면 기본 필드 value 로 조회한다', async () => {
    pageBridge.isSecretField.mockReset()
    pageBridge.isSecretField.mockImplementation(async () => true)
    const b = build()
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })).toBe('ok')
    expect(b.getSecretForFill).toHaveBeenCalledWith(1, 'login', 'value', 'job-1')
  })

  it('카드 번호는 field 로 지정해 채우고, 반환 문자열에 값이 없다', async () => {
    const CARD = '4111111111111111'
    const b = build({ secret: CARD })
    const result = await callTool(b, 'fill_secret', {
      elementId: 3,
      itemType: 'card',
      field: 'card.number'
    })
    expect(result).toBe('ok')
    expect(result).not.toContain(CARD)
    expect(b.getSecretForFill).toHaveBeenCalledWith(1, 'card', 'card.number', 'job-1')
    // step 라벨에도 값이 남지 않는다
    expect(JSON.stringify(b.steps)).not.toContain(CARD)
  })
})

describe('항목별 agentAccess', () => {
  it("agentAccess:'never' 계정은 금고가 열려 있어도 거부한다", async () => {
    const b = build({
      state: 'unlocked',
      accounts: [account({ agentAccess: 'never' })],
      vaultAccessPolicy: 'always'
    })
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })).toBe(
      'refused: KeyMaster access policy is Never'
    )
    expect(b.getSecretForFill).not.toHaveBeenCalled()
  })

  it("agentAccess:'always' 계정은 전역 정책이 while_unlocked 여도 기기 키로 자동 해제한다", async () => {
    const b = build({
      state: 'locked',
      accounts: [account({ agentAccess: 'always' })],
      vaultAccessPolicy: 'while_unlocked',
      deviceUnlockSucceeds: true
    })
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })).toBe('ok')
    expect(b.ensureUnlockedByDevice).toHaveBeenCalled()
  })

  it("agentAccess:'inherit' 은 전역 정책(never)을 그대로 따른다", async () => {
    const b = build({
      accounts: [account({ agentAccess: 'inherit' })],
      vaultAccessPolicy: 'never'
    })
    expect(await callTool(b, 'fill_secret', { elementId: 2, itemType: 'login' })).toBe(
      'refused: KeyMaster access policy is Never'
    )
  })
})

describe('계정 순회(login 의 탭 프로필 자동 선택)', () => {
  it('라벨 없이도 탭 profile 과 같은 라벨의 계정을 고른다', async () => {
    const b = build({
      tabProfile: '부계정',
      accounts: [account({ id: 1, label: '메인' }), account({ id: 2, label: '부계정' })]
    })
    expect(await callTool(b, 'login', {})).toContain('submitted')
    expect(b.getSecretForFill).toHaveBeenCalledWith(2, 'login', 'value', 'job-1')
  })

  it('accountLabel 을 주면 탭 profile 보다 라벨이 우선한다', async () => {
    const b = build({
      tabProfile: '부계정',
      accounts: [account({ id: 1, label: '메인' }), account({ id: 2, label: '부계정' })]
    })
    expect(await callTool(b, 'login', { accountLabel: '메인' })).toContain('submitted')
    expect(b.getSecretForFill).toHaveBeenCalledWith(1, 'login', 'value', 'job-1')
  })
})

describe('list_accounts 응답', () => {
  it('태그를 함께 돌려준다', async () => {
    const b = build({ accounts: [account({ tags: ['쇼핑', '해외'] })] })
    const raw = await callTool(b, 'list_accounts', {})
    expect(JSON.parse(raw)).toEqual([
      { label: '메인', username: 'ho***', types: ['login'], tags: ['쇼핑', '해외'] }
    ])
  })
})
