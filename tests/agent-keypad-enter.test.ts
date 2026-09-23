// fill_secret 이 웹 결제 키패드 화면에서 키마스터 값을 앱이 직접 누르는 분기.
// 값이 도구 결과·라벨·클릭 인자 어디에도 새지 않는지, 계정 도메인 검사와 실패 시 넘김을 본다

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { VaultService } from '../src/main/vault/service'
import type { HandoffResult } from '../src/main/agent/handoff'
import type { AccountDto, VaultState } from '../src/shared/vault'

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
    keypadSignals: vi.fn(),
    keypadSignalsAll: undefined as unknown,
    keypadLayout: vi.fn(),
    keypadUnlabeled: vi.fn(),
    keypadFilled: vi.fn(),
    snapshot: vi.fn(async () => ({ url: '', title: '', text: '', elements: [], total: 0 })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    pressOnce: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    fillValue: vi.fn(async () => 'ok'),
    // 로그인 칸 진짜 키 입력 — 테스트에서는 fillValue 와 같은 목으로 흘려 기존 기대를 그대로 둔다
    typeLogin: vi.fn(async (tab: unknown, id: number, value: string) =>
      pageBridge.fillValue(tab, id, value)
    ),
    isSecretField: vi.fn(async () => true),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

// 글자 없는 키패드(네이버페이)의 칸별 OCR. 실제 캡처·모델 대신 칸 좌표로 숫자를 정한다
const { ocrDigitInRegion } = vi.hoisted(() => ({
  ocrDigitInRegion: vi.fn<(tab: unknown, rect: { x: number }) => Promise<string | null>>()
}))
vi.mock('../src/main/agent/tools-ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/agent/tools-ocr')>()),
  ocrDigitInRegion
}))

const { createSambaTools, KEYPAD_DRY_RUN, KEYPAD_ENTERED_NEXT, KEYPAD_HANDOFF_MESSAGE } =
  await import('../src/main/agent/tools')
const { secretKeypadGate } = await import('../src/main/agent/secret-page')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

const SECRET = '149072'
const SECRET_RE = /149072/
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const SHOP = 'https://order.musinsa.com/checkout'
const PG = 'https://m.niceepay.com/app/pinCert.do'

// NICE ePAY 키패드 화면 신호
const keypadSignals = (url: string): Record<string, unknown> => ({
  url,
  text: '결제 비밀번호 6자리를 입력해 주세요',
  digitButtons: 10,
  pinField: true
})

/** 숫자 d 의 버튼 id 는 100+d */
function layoutOf(filled: number | null = 0): Record<string, unknown> {
  const digits: Record<string, number> = {}
  for (const d of DIGITS) digits[d] = 100 + Number(d)
  return { digits, filled, frameIndex: 0 }
}

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host: 'musinsa.com',
    label: '메인',
    username: 'hong',
    isDefault: true,
    itemTypes: ['login', 'password'],
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
  listAccounts: ReturnType<typeof vi.fn>
  closeTarget: ReturnType<typeof vi.fn>
  getPaymentSecretForFill: ReturnType<typeof vi.fn>
  handoff: ReturnType<typeof vi.fn>
}

function build(
  opts: {
    mode?: ToolContext['mode']
    state?: VaultState
    /** 키패드가 뜬 창의 주소. 기본은 무신사 주문서 안(iframe) */
    tabUrl?: string
    /** 팝업이면 그 창을 연 탭의 주소 */
    openerUrl?: string
    accounts?: AccountDto[]
    payment?: { value: string | null; reason?: 'not-found' | 'ambiguous' | 'locked' }
    confirmResult?: boolean
    withVault?: boolean
    vaultExcludedHosts?: string[]
    /** 키패드 창의 프로필(파티션) — 계정 라벨 자동 선택에 쓰인다 */
    tabProfile?: string
    /** 계정별로 결제될 네이버 아이디(네이버페이 창 계정 검사·창 표시로 계정 고르기) */
    paymentAccountUsername?: (accountId: number) => string | null
    /** 키패드 창을 연 대상 id(openerUrl 대신 targets 로 사슬을 준다) */
    openerId?: string
    /** 탭+팝업 전체 목록(opener 사슬 검사용) */
    targets?: AgentTarget[]
  } = {}
): Built {
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const closeTarget = vi.fn()
  const steps: Array<{ label: string; ok: boolean }> = []
  // 실제 VaultService.listAccounts 처럼 등록 도메인(eTLD+1)이 같으면 같은 사이트로 본다
  const domainOf = (h: string): string => h.split('.').slice(-2).join('.')
  const listAccounts = vi.fn((host: string) =>
    (opts.accounts ?? [account()]).filter((a) => domainOf(host) === domainOf(a.host))
  )
  const getPaymentSecretForFill = vi.fn(() => opts.payment ?? { value: SECRET })
  const vault = {
    state: () => opts.state ?? 'unlocked',
    listAccounts,
    getSecretForFill: vi.fn(),
    getPaymentSecretForFill,
    ensureUnlockedByDevice: vi.fn(async () => false),
    // 네이버페이 창 계정 확인 — 기대 아이디가 없으면 확인을 건너뛴다
    paymentAccountUsername: vi.fn(
      (accountId: number) => opts.paymentAccountUsername?.(accountId) ?? null
    )
  } as unknown as VaultService
  const tabUrl = opts.tabUrl ?? SHOP
  const tab = {
    id: 'pay-1',
    view: { webContents: { getURL: () => tabUrl, isDestroyed: () => false } },
    profile: opts.tabProfile ?? 'default',
    mobile: false,
    ...(opts.openerId !== undefined
      ? { openerId: opts.openerId }
      : opts.openerUrl === undefined
        ? {}
        : { openerId: 'shop-1' })
  }
  const tabs = {
    active: () => tab,
    create: vi.fn(),
    activate: vi.fn(),
    list: () =>
      opts.openerUrl === undefined
        ? []
        : [{ id: 'shop-1', url: opts.openerUrl, title: '주문서', active: true }],
    // 탭+팝업 목록. 주지 않으면 탭 목록을 그대로 대상 목록으로 쓴다
    ...(opts.targets
      ? { listTargets: () => opts.targets }
      : opts.openerUrl !== undefined
        ? {
            listTargets: () => [
              { id: 'shop-1', kind: 'tab', url: opts.openerUrl, title: '주문서', active: true }
            ]
          }
        : {}),
    navigate: vi.fn(async () => {}),
    closeTarget
  } as unknown as TabManager
  const handoff = vi.fn(async (): Promise<HandoffResult> => ({
    outcome: 'resumed',
    url: 'https://order.musinsa.com/done'
  }))
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: opts.mode ?? 'full',
    finalConfirm: false,
    confirm,
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok }),
    ...(opts.withVault === false ? {} : { vault }),
    jobId: 'job-1',
    handoff,
    vaultExcludedHosts: opts.vaultExcludedHosts
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return {
    tools: new Map(server.tools.map((t) => [t.name, t])),
    confirm,
    steps,
    listAccounts,
    closeTarget,
    getPaymentSecretForFill,
    handoff
  }
}

async function fill(b: Built, args: Record<string, unknown> = {}): Promise<string> {
  const r = await b.tools.get('fill_secret')!.handler({
    elementId: 5,
    itemType: 'password',
    provider: 'site',
    ...args
  })
  return r.content[0].text
}

beforeEach(() => {
  secretKeypadGate.clear()
  pageBridge.pressOnce.mockClear()
  pageBridge.keypadSignals.mockReset()
  pageBridge.keypadSignals.mockResolvedValue(keypadSignals(SHOP))
  pageBridge.keypadLayout.mockReset()
  pageBridge.keypadLayout.mockResolvedValue(layoutOf())
  pageBridge.keypadUnlabeled.mockReset()
  pageBridge.keypadUnlabeled.mockResolvedValue(null)
  ocrDigitInRegion.mockReset()
  ocrDigitInRegion.mockResolvedValue(null)
  pageBridge.keypadFilled.mockReset()
  // 누를 때마다 자리수가 하나씩 늘어난다
  let n = 0
  pageBridge.keypadFilled.mockImplementation(async () => n)
  pageBridge.pressOnce.mockImplementation(async () => {
    n += 1
    return 'ok'
  })
})

describe('fill_secret — 키패드 화면에서 앱이 결제 비밀번호를 누른다', () => {
  it('배치를 읽어 자리수만큼 숫자 버튼을 순서대로 누르고, 확인 버튼은 모델에게 맡긴다', async () => {
    const b = build()
    const r = await fill(b)
    expect(r).toBe(KEYPAD_ENTERED_NEXT)
    expect(pageBridge.pressOnce.mock.calls.map((c) => c[1])).toEqual(
      SECRET.split('').map((d) => 100 + Number(d))
    )
    expect(b.handoff).not.toHaveBeenCalled()
    expect(b.getPaymentSecretForFill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 1, provider: 'site', jobId: 'job-1' })
    )
  })

  it('결과·진행 라벨 어디에도 값이 없다(라벨은 자리수만)', async () => {
    const b = build()
    const r = await fill(b)
    expect(SECRET_RE.test(r)).toBe(false)
    expect(b.steps.map((s) => s.label)).toContain('결제 비밀번호 입력(6자리)')
    expect(b.steps.some((s) => SECRET_RE.test(s.label))).toBe(false)
  })

  it('full 모드는 묻지 않고, guard 모드는 한 번 확인한다(거부하면 누르지 않는다)', async () => {
    const full = build({ mode: 'full' })
    await fill(full)
    expect(full.confirm).not.toHaveBeenCalled()
    const guard = build({ mode: 'guard', confirmResult: false })
    expect(await fill(guard)).toBe('denied by user')
    expect(guard.confirm).toHaveBeenCalledTimes(1)
    expect(pageBridge.pressOnce).toHaveBeenCalledTimes(6) // full 쪽 6번만
  })

  it('PG 팝업(niceepay)이라도 계정 사이트 탭이 연 창이면 그 계정으로 누른다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const b = build({ tabUrl: PG, openerUrl: SHOP })
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
    // 팝업 호스트로는 계정이 없어 opener 호스트로 다시 찾는다
    expect(b.listAccounts.mock.calls.map((c) => c[0])).toEqual([
      'm.niceepay.com',
      'order.musinsa.com'
    ])
  })

  it('같은 이름의 계정이 여럿이면 결제 비밀번호를 가진 계정을 고른다(실기: 로그인 도메인별 alice 3개)', async () => {
    const b = build({
      accounts: [
        account({ id: 1, host: 'musinsa.com', label: 'alice', itemTypes: ['login'] }),
        account({ id: 2, host: 'my.musinsa.com', label: 'alice', itemTypes: ['login'] }),
        account({
          id: 3,
          host: 'member.one.musinsa.com',
          label: 'alice',
          itemTypes: ['login', 'password']
        })
      ],
      tabProfile: 'alice'
    })
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
    expect(b.getPaymentSecretForFill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 3 })
    )
  })

  it('라벨도 프로필도 없으면(기본 프로필 탭) 결제창을 연 쇼핑몰 계정 중 결제 비밀번호 항목이 있는 하나를 고른다(실기 7차)', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const b = build({
      tabUrl: PG,
      openerUrl: SHOP,
      tabProfile: 'default',
      accounts: [
        account({
          id: 11,
          host: 'niceepay.com',
          label: 'pg-a',
          isDefault: false,
          itemTypes: ['login', 'password']
        }),
        account({
          id: 12,
          host: 'niceepay.com',
          label: 'pg-b',
          isDefault: false,
          itemTypes: ['login', 'password']
        }),
        account({
          id: 21,
          host: 'musinsa.com',
          label: 'shop-login-only',
          isDefault: false,
          itemTypes: ['login']
        }),
        account({
          id: 22,
          host: 'musinsa.com',
          label: 'shop-with-pw',
          isDefault: false,
          itemTypes: ['login', 'password']
        })
      ]
    })
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
    expect(b.getPaymentSecretForFill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 22 })
    )
  })

  it('쇼핑몰 쪽 후보가 둘 이상이면 고르지 않는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const b = build({
      tabUrl: PG,
      openerUrl: SHOP,
      tabProfile: 'default',
      accounts: [
        account({
          id: 21,
          host: 'musinsa.com',
          label: 'a',
          isDefault: false,
          itemTypes: ['login', 'password']
        }),
        account({
          id: 22,
          host: 'musinsa.com',
          label: 'b',
          isDefault: false,
          itemTypes: ['login', 'password']
        })
      ]
    })
    expect(await fill(b)).toContain('not linked to a saved account')
    expect(b.steps.some((s) => s.label.startsWith('키패드 계정 못 고름('))).toBe(true)
  })

  it('팝업 안에서 열린 팝업(무신사머니 창 → ePAY)도 opener 사슬을 따라 계정 사이트를 찾는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const b = build({
      tabUrl: PG,
      openerId: 'money-popup',
      targets: [
        { id: 'shop-1', kind: 'tab', url: SHOP, title: '주문서', active: true },
        {
          id: 'money-popup',
          kind: 'popup',
          url: 'https://pay.musinsapayments.com/payment',
          title: '무신사머니',
          openerId: 'shop-1',
          active: false
        }
      ]
    })
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
  })

  it('계정 사이트와 무관한 창의 키패드에는 넣지 않는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const alone = build({ tabUrl: PG })
    expect(await fill(alone)).toMatch(/^account not found/)
    const other = build({ tabUrl: PG, openerUrl: 'https://www.29cm.co.kr/order' })
    expect(await fill(other)).toMatch(/^account not found/)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('제외 도메인·평문(http) 결제창에는 넣지 않는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const excluded = build({ tabUrl: PG, openerUrl: SHOP, vaultExcludedHosts: ['niceepay.com'] })
    expect(await fill(excluded)).toMatch(/excluded/)
    const insecure = build({ tabUrl: 'http://m.niceepay.com/app/pinCert.do', openerUrl: SHOP })
    expect(await fill(insecure)).toMatch(/insecure/)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('배치를 못 읽으면 누르지 않고 사람에게 넘긴다', async () => {
    pageBridge.keypadLayout.mockResolvedValue(null)
    const b = build()
    const r = await fill(b)
    expect(r).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(b.handoff).toHaveBeenCalledTimes(1)
    expect(b.handoff.mock.calls[0][0].kind).toBe('keypad')
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('눌러도 자리수가 늘지 않으면 첫 자리에서 멈추고 사람에게 넘긴다', async () => {
    pageBridge.keypadFilled.mockImplementation(async () => 0)
    const b = build()
    const r = await fill(b)
    expect(r).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.pressOnce).toHaveBeenCalledTimes(1)
    expect(b.handoff).toHaveBeenCalledTimes(1)
  })

  it('금고가 잠겨 있거나 없으면 예전처럼 사람에게 넘긴다', async () => {
    const locked = build({ state: 'locked' })
    expect(await fill(locked)).toContain(KEYPAD_HANDOFF_MESSAGE)
    const none = build({ withVault: false })
    expect(await fill(none)).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('결제 수단이 여럿인데 provider 가 없으면 되묻고, 항목이 없으면 not found', async () => {
    const many = build({ payment: { value: null, reason: 'ambiguous' } })
    expect(await fill(many, { provider: undefined })).toMatch(/^ambiguous/)
    const none = build({ payment: { value: null, reason: 'not-found' } })
    expect(await fill(none)).toMatch(/^not found: no payment password \(site\)/)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('결제 비밀번호가 아닌 항목(login)을 키패드 화면에서 부르면 넘긴다', async () => {
    const b = build()
    const r = await fill(b, { itemType: 'login', provider: undefined })
    expect(r).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })
})

describe('fill_secret — 시험 입력(dry-run)', () => {
  // 키패드가 뜬 창이 팝업(결제창)인 경우의 대상 목록
  const popupTargets = [
    { id: 'shop-1', kind: 'tab' as const, url: SHOP, title: '주문서', active: true },
    {
      id: 'pay-1',
      kind: 'popup' as const,
      url: PG,
      title: '결제',
      openerId: 'shop-1',
      active: false
    }
  ]

  it('지정한 자리수만 누르고 결제창(팝업)을 닫는다 — 결제는 하지 않는다', async () => {
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(PG))
    const b = build({ tabUrl: PG, openerUrl: SHOP, targets: popupTargets })
    const r = await fill(b, { dryRunDigits: 3 })

    expect(r).toBe(KEYPAD_DRY_RUN(3, 'popup closed'))
    expect(r).toContain('DRY_RUN')
    expect(pageBridge.pressOnce).toHaveBeenCalledTimes(3)
    expect(b.closeTarget).toHaveBeenCalledWith('pay-1')
    // 값은 결과·라벨 어디에도 없다
    expect(SECRET_RE.test(r)).toBe(false)
    expect(b.steps.some((x) => SECRET_RE.test(x.label))).toBe(false)
    expect(b.steps.map((x) => x.label)).toContain(
      '시험 입력: 결제 비밀번호 3자리만 누름(결제 안 함)'
    )
  })

  it('팝업이 아니면 취소 버튼을 눌러 키패드를 빠져나온다', async () => {
    pageBridge.snapshot.mockResolvedValueOnce({
      url: SHOP,
      title: '주문서',
      text: '',
      elements: [{ id: 9, tag: 'button', role: 'button', text: '취소', isSecret: false }],
      total: 1
    })
    const b = build()
    const r = await fill(b, { dryRunDigits: 2 })

    expect(r).toBe(KEYPAD_DRY_RUN(2, 'cancel button clicked'))
    expect(pageBridge.click).toHaveBeenCalledWith(expect.anything(), 9)
    expect(b.closeTarget).not.toHaveBeenCalled()
  })

  it('시험 입력은 키패드 1회 제한을 쓰지 않는다(뒤이은 진짜 입력이 통한다)', async () => {
    const b = build()
    expect(await fill(b, { dryRunDigits: 1 })).toContain('DRY_RUN')
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
  })
})

describe('fill_secret — 글자 없는 키패드(네이버페이)는 OCR 로 배치를 만든다', () => {
  const NAVER = 'https://pay.naver.com/authentication/pw/check?token=abc'
  const SHOP_NAVER = 'https://smartstore.naver.com/shop/order'
  const naverAccount = account({ host: 'naver.com' })
  const popupTargets = [
    { id: 'shop-1', kind: 'tab' as const, url: SHOP_NAVER, title: '주문서', active: true },
    {
      id: 'pay-1',
      kind: 'popup' as const,
      url: NAVER,
      title: '네이버페이',
      openerId: 'shop-1',
      active: false
    }
  ]
  // 칸 i 의 id 는 200+i, x 는 i*50. 화면 숫자는 (i+3)%10 으로 섞여 있다
  const cells = Array.from({ length: 10 }, (_, i) => ({
    id: 200 + i,
    x: i * 50,
    y: 0,
    width: 50,
    height: 50
  }))
  const digitOfCell = (rect: { x: number }): string => String((rect.x / 50 + 3) % 10)
  const idOfDigit = (d: string): number => 200 + ((Number(d) + 7) % 10)

  beforeEach(() => {
    pageBridge.keypadSignals.mockResolvedValue({
      url: NAVER,
      text: '비밀번호는 6자리 입니다',
      digitButtons: 0,
      pinField: false
    })
    pageBridge.keypadLayout.mockResolvedValue(null)
    pageBridge.keypadUnlabeled.mockResolvedValue(cells)
    // 입력칸이 없는 화면이라 자리수를 셀 수 없다
    pageBridge.keypadFilled.mockResolvedValue(null)
  })

  it('칸마다 읽은 숫자로 배치를 만들어 순서대로 한 번씩 누른다(검증 없음)', async () => {
    ocrDigitInRegion.mockImplementation(async (_tab, rect) => digitOfCell(rect))
    const b = build({ tabUrl: NAVER, accounts: [naverAccount], openerUrl: SHOP_NAVER })
    const r = await fill(b)

    expect(r).toBe(KEYPAD_ENTERED_NEXT)
    expect(pageBridge.pressOnce.mock.calls.map((c) => c[1])).toEqual(
      SECRET.split('').map(idOfDigit)
    )
    expect(pageBridge.keypadFilled).not.toHaveBeenCalled()
    expect(b.handoff).not.toHaveBeenCalled()
    expect(b.steps).toContainEqual({ label: '키패드 배치(OCR)', ok: true })
    // 값도 배치도 결과·라벨에 없다
    expect(SECRET_RE.test(r)).toBe(false)
    expect(b.steps.some((x) => SECRET_RE.test(x.label) || /\b2\d\d\b/.test(x.label))).toBe(false)
  })

  it('시험 입력은 지정한 자리수만 누르고 결제창(팝업)을 닫는다', async () => {
    ocrDigitInRegion.mockImplementation(async (_tab, rect) => digitOfCell(rect))
    const b = build({ tabUrl: NAVER, accounts: [naverAccount], targets: popupTargets })
    const r = await fill(b, { dryRunDigits: 3 })

    expect(r).toBe(KEYPAD_DRY_RUN(3, 'popup closed'))
    expect(pageBridge.pressOnce.mock.calls.map((c) => c[1])).toEqual(
      SECRET.slice(0, 3).split('').map(idOfDigit)
    )
    expect(b.closeTarget).toHaveBeenCalledWith('pay-1')
  })

  it('라벨·프로필 없이 쇼핑몰 계정 여럿이 결제 비밀번호를 가지면 창에 표시된 아이디로 고른다(실기 8차)', async () => {
    ocrDigitInRegion.mockImplementation(async (_tab, rect) => digitOfCell(rect))
    pageBridge.snapshot.mockResolvedValue({
      url: NAVER,
      title: '네이버페이',
      text: '네이버페이 인증 김사무 ( ) buyer01 님의 비밀번호 입력 비밀번호는 6자리 입니다.',
      elements: [],
      total: 0
    })
    const shop = 'https://abcmart.a-rt.com/order'
    const linked: Record<number, string> = { 5: 'buyer02', 6: 'buyer01', 8: 'buyer03' }
    const b = build({
      tabUrl: NAVER,
      openerUrl: shop,
      tabProfile: 'default',
      paymentAccountUsername: (id) => linked[id] ?? null,
      accounts: [
        account({ id: 5, host: 'a-rt.com', label: 'buyer02', isDefault: false }),
        account({ id: 6, host: 'a-rt.com', label: 'buyer01', isDefault: false }),
        account({ id: 8, host: 'a-rt.com', label: 'buyer03', isDefault: false }),
        account({
          id: 10,
          host: 'a-rt.com',
          label: 'buyer04',
          isDefault: false,
          itemTypes: ['login']
        })
      ]
    })
    const r = await fill(b, { dryRunDigits: 3 })
    expect(r).toBe(KEYPAD_DRY_RUN(3, 'popup closed'))
    expect(b.getPaymentSecretForFill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 6 })
    )
    expect(b.steps).toContainEqual({ label: '네이버페이 창 계정 확인: buyer01', ok: true })
  })

  it('0~9 중 하나라도 못 읽으면(9개만 읽힘) 누르지 않고 사람에게 넘긴다', async () => {
    ocrDigitInRegion.mockImplementation(async (_tab, rect) =>
      rect.x === 0 ? null : digitOfCell(rect)
    )
    const b = build({ tabUrl: NAVER, accounts: [naverAccount], openerUrl: SHOP_NAVER })
    expect(await fill(b)).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
    expect(b.handoff).toHaveBeenCalledTimes(1)
    expect(b.steps).toContainEqual({ label: '키패드 배치(OCR)', ok: false })
  })

  it('같은 숫자가 두 칸에서 읽히면 배치를 버리고 넘긴다', async () => {
    ocrDigitInRegion.mockImplementation(async (_tab, rect) =>
      rect.x === 0 ? '4' : digitOfCell(rect)
    )
    const b = build({ tabUrl: NAVER, accounts: [naverAccount], openerUrl: SHOP_NAVER })
    expect(await fill(b)).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
  })

  it('OCR 이 꺼져 있거나 모델이 없으면(null) 넘긴다', async () => {
    const b = build({ tabUrl: NAVER, accounts: [naverAccount], openerUrl: SHOP_NAVER })
    expect(await fill(b)).toContain(KEYPAD_HANDOFF_MESSAGE)
    expect(ocrDigitInRegion).toHaveBeenCalled()
    expect(pageBridge.pressOnce).not.toHaveBeenCalled()
    expect(b.handoff).toHaveBeenCalledTimes(1)
  })

  it('글자 있는 키패드는 예전처럼 OCR 을 쓰지 않는다', async () => {
    pageBridge.keypadLayout.mockResolvedValue(layoutOf())
    pageBridge.keypadSignals.mockResolvedValue(keypadSignals(SHOP))
    pageBridge.keypadFilled.mockReset()
    let n = 0
    pageBridge.keypadFilled.mockImplementation(async () => n)
    pageBridge.pressOnce.mockImplementation(async () => {
      n += 1
      return 'ok'
    })
    const b = build()
    expect(await fill(b)).toBe(KEYPAD_ENTERED_NEXT)
    expect(pageBridge.keypadUnlabeled).not.toHaveBeenCalled()
    expect(ocrDigitInRegion).not.toHaveBeenCalled()
    expect(b.steps.some((x) => x.label === '키패드 배치(OCR)')).toBe(false)
  })
})
