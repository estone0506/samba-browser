// 간편결제 앱 승인 흐름. 상한 검사·확인 카드·상태 전이와 "재시도 없음" 을 단언한다

import { describe, it, expect, vi } from 'vitest'

// SDK 의 tool() 을 얇게 대체해 도구 핸들러를 직접 부른다(다른 agent 테스트와 같은 방식)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

import {
  PAY_APP_TO_PAYMENT_PROVIDER,
  PAY_PROVIDERS,
  findPayNotification,
  parseAppNotifications,
  checkPaymentGate,
  nextPayState,
  runPayApproval,
  type PayRequest,
  type PayResult,
  type PayRunDeps
} from '../src/main/phone/pay'
import { createPayTool, PAY_TOOL_NAME, PHONE_TOOL_NAMES } from '../src/main/agent/tools-phone'
import { SAMBA_TOOL_NAMES } from '../src/main/agent/tools'
import { DEFAULT_PAYMENT_LIMIT_KRW, FIRST_RUN_LIMIT_KRW } from '../src/shared/phone'

// 사용자가 설정에 적어 넣은 상한(테스트용 값). 기본값은 둘 다 없음(0)이다
const USER_LIMIT_KRW = 500_000
const USER_FIRST_LIMIT_KRW = 10_000
import type { PhoneElement, PhoneScreen } from '../src/shared/phone-snapshot'
import type { KeypadLayout } from '../src/main/ai/visual'

const SERIAL = 'R3CRA05HY3R'
const TOSS = PAY_PROVIDERS.toss

function el(id: number, text: string, extra: Partial<PhoneElement> = {}): PhoneElement {
  return {
    id,
    text,
    className: 'android.widget.Button',
    clickable: true,
    bounds: { l: 0, t: id * 100, r: 200, b: id * 100 + 60 },
    center: { x: 100, y: id * 100 + 30 },
    isSecret: false,
    ...extra
  }
}

function screen(app: string, elements: PhoneElement[] = []): PhoneScreen {
  return { serial: SERIAL, width: 720, height: 1600, app, elements }
}

const fullLayout: KeypadLayout = {
  digits: Object.fromEntries(
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => [
      d,
      { x: Number(d) * 10, y: 500 }
    ])
  )
}

function request(over: Partial<PayRequest> = {}): PayRequest {
  return {
    provider: 'toss',
    amountKrw: 12_000,
    merchant: '삼바상회',
    methodLabel: '토스페이',
    phoneLabel: '내 폰',
    accountId: 7,
    phoneId: 1,
    serial: SERIAL,
    siteHost: 'shop.example.com',
    jobId: 'job-1',
    isFirstRunForCombo: false,
    ...over
  }
}

interface Harness {
  deps: PayRunDeps
  screens: PhoneScreen[]
  taps: Array<[string, number, number]>
  confirm: ReturnType<typeof vi.fn>
  tapPassword: ReturnType<typeof vi.fn>
  records: Array<{ kind: string; ok: boolean }>
  notices: Array<{ message: string; hasImage: boolean }>
  steps: Array<{ label: string; ok: boolean }>
}

/** screens 를 순서대로 돌려주고, 다 쓰면 마지막 화면을 계속 돌려준다 */
function harness(
  opts: {
    screens?: PhoneScreen[]
    confirmResult?: boolean
    vaultUnlocked?: boolean
    webSuccess?: boolean
    password?: 'ok' | 'locked' | 'not-found' | 'ambiguous' | 'layout-incomplete'
    uiKeypad?: KeypadLayout | null
    visualKeypad?: KeypadLayout | null
    screenshotSecret?: boolean
  } = {}
): Harness {
  const screens = opts.screens ?? [screen('viva.republica.toss')]
  const taps: Array<[string, number, number]> = []
  const records: Array<{ kind: string; ok: boolean }> = []
  const notices: Array<{ message: string; hasImage: boolean }> = []
  const steps: Array<{ label: string; ok: boolean }> = []
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const tapPassword = vi.fn(async () => opts.password ?? 'ok')
  let idx = 0
  let clock = 1000

  const deps: PayRunDeps = {
    phones: {
      screen: async () => screens[Math.min(idx++, screens.length - 1)],
      tap: async (serial, x, y) => {
        taps.push([serial, x, y])
      },
      screenshot: async () =>
        opts.screenshotSecret
          ? { png: Buffer.alloc(0), secret: true }
          : { png: Buffer.from([1, 2, 3]), secret: false }
    },
    launchApp: vi.fn(async () => {}),
    confirm,
    vault: {
      state: () => 'unlocked',
      getPaymentSecretForFill: () => ({ value: '149072' })
    },
    vaultUnlocked: () => opts.vaultUnlocked ?? true,
    keypad: {
      fromUiTree: () => (opts.uiKeypad === undefined ? fullLayout : opts.uiKeypad),
      fromVisual: async () => opts.visualKeypad ?? null
    },
    webSuccess: async () => opts.webSuccess ?? true,
    record: (e) => records.push({ kind: e.kind, ok: e.ok }),
    notify: (message, png) => notices.push({ message, hasImage: png !== undefined }),
    onStep: (label, ok) => steps.push({ label, ok }),
    now: () => (clock += 10),
    sleep: async () => {},
    tapPassword
  }
  return { deps, screens, taps, confirm, tapPassword, records, notices, steps }
}

describe('PAY_APP_TO_PAYMENT_PROVIDER', () => {
  it('결제앱 4종이 모두 금고 결제 수단으로 이어진다', () => {
    expect(PAY_APP_TO_PAYMENT_PROVIDER).toEqual({
      toss: 'toss',
      payco: 'payco',
      kakaopay: 'kakao',
      naverpay: 'naver'
    })
    // 앱 목록과 매핑표가 어긋나면(새 앱 추가 후 매핑 누락) 여기서 걸린다
    expect(Object.keys(PAY_APP_TO_PAYMENT_PROVIDER).sort()).toEqual(
      Object.keys(PAY_PROVIDERS).sort()
    )
  })
})

describe('checkPaymentGate', () => {
  const base = {
    amountKrw: 10_000,
    limitKrw: USER_LIMIT_KRW,
    isFirstRunForCombo: false,
    vaultUnlocked: true
  }

  it('상한 안이면 ok', () => {
    expect(checkPaymentGate(base)).toBe('ok')
  })

  it('상한을 넘으면 over-limit', () => {
    expect(checkPaymentGate({ ...base, amountKrw: USER_LIMIT_KRW + 1 })).toBe('over-limit')
  })

  it('기본값은 상한 없음 — 앱이 임의로 금액을 막지 않는다', () => {
    expect(DEFAULT_PAYMENT_LIMIT_KRW).toBe(0)
    expect(FIRST_RUN_LIMIT_KRW).toBe(0)
    const free = { ...base, limitKrw: DEFAULT_PAYMENT_LIMIT_KRW, isFirstRunForCombo: true }
    expect(checkPaymentGate({ ...free, amountKrw: 10_000_000 })).toBe('ok')
  })

  it('사용자가 첫 결제 상한을 적어 두었을 때만, 새 조합의 첫 결제가 그 값을 넘으면 first-run-too-large', () => {
    const first = { ...base, isFirstRunForCombo: true, firstRunLimitKrw: USER_FIRST_LIMIT_KRW }
    expect(checkPaymentGate({ ...first, amountKrw: USER_FIRST_LIMIT_KRW + 1 })).toBe(
      'first-run-too-large'
    )
    expect(checkPaymentGate({ ...first, amountKrw: USER_FIRST_LIMIT_KRW })).toBe('ok')
  })

  it('금고가 잠겨 있으면 vault-locked', () => {
    expect(checkPaymentGate({ ...base, vaultUnlocked: false })).toBe('vault-locked')
  })
})

describe('nextPayState', () => {
  it('앱 패키지가 뜨면 app_steps 로 가고 확인 버튼 번호를 함께 돌려준다', () => {
    const s = screen('viva.republica.toss', [el(1, '결제하기')])
    expect(nextPayState('await_app', s, TOSS)).toEqual({ state: 'app_steps', tapElementId: 1 })
  })

  it('앱이 아직 안 떴으면 await_app 을 유지한다', () => {
    const s = screen('com.android.chrome', [el(1, '결제하기')])
    expect(nextPayState('await_app', s, TOSS)).toEqual({ state: 'await_app' })
  })

  it('비밀번호 화면 표식이 보이면 password', () => {
    const s = screen('viva.republica.toss', [el(1, '간편비밀번호 입력', { clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'password' })
  })

  it('비밀 입력칸만 있어도 password 로 본다', () => {
    const s = screen('viva.republica.toss', [el(1, '', { isSecret: true, clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'password' })
  })

  it('성공 표식이 보이면 verify', () => {
    const s = screen('viva.republica.toss', [el(1, '결제 완료', { clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'verify' })
  })

  it('verify 에서 성공 표식을 다시 보면 done', () => {
    const s = screen('viva.republica.toss', [el(1, '결제가 완료되었습니다', { clickable: false })])
    expect(nextPayState('verify', s, TOSS)).toEqual({ state: 'done' })
  })

  it('아무 표식이 없으면 상태를 유지하고 누를 곳을 주지 않는다', () => {
    const s = screen('viva.republica.toss', [el(1, '주문 내역')])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'app_steps' })
  })
})

describe('runPayApproval', () => {
  const okScreens = [
    screen('viva.republica.toss', [el(1, '결제하기')]),
    screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })]),
    screen('viva.republica.toss', [el(3, '결제 완료', { clickable: false })])
  ]

  it('권한 모드와 무관하게 확인 카드를 정확히 1회 띄운다', async () => {
    const h = harness({ screens: okScreens })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: true })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    // 카드에 금액·가맹점·결제수단·폰 별칭이 모두 들어간다
    const card = String(h.confirm.mock.calls[0][0])
    expect(card).toContain('12,000')
    expect(card).toContain('삼바상회')
    expect(card).toContain('토스페이')
    expect(card).toContain('내 폰')
  })

  it('사용자가 거부하면 아무것도 누르지 않고 declined', async () => {
    const h = harness({ screens: okScreens, confirmResult: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'declined' })
    expect(h.taps).toEqual([])
    expect(h.tapPassword).not.toHaveBeenCalled()
    expect(h.deps.launchApp).not.toHaveBeenCalled()
  })

  it('사용자가 적은 상한을 넘으면 확인 카드도 띄우지 않고 거부한다', async () => {
    const h = harness({ screens: okScreens })
    const r = await runPayApproval(
      h.deps,
      request({ amountKrw: 900_000, limitKrw: USER_LIMIT_KRW })
    )

    expect(r).toEqual({ ok: false, reason: 'over-limit' })
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.records).toEqual([{ kind: 'app_approve', ok: false }])
  })

  it('금고가 잠겨 있으면 비밀번호를 건드리지 않는다', async () => {
    const h = harness({ screens: okScreens, vaultUnlocked: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'vault-locked' })
    expect(h.tapPassword).not.toHaveBeenCalled()
  })

  it('결제앱에 맞는 금고 결제 수단을 비밀번호 입력기에 넘긴다', async () => {
    const h = harness({ screens: okScreens })
    await runPayApproval(h.deps, request({ provider: 'toss' }))

    expect(h.tapPassword).toHaveBeenCalledTimes(1)
    // 계정의 결제 비밀번호 아무거나가 아니라 이 앱(토스)의 항목만 읽게 좁혀 넘긴다
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ provider: 'toss', accountId: 7 })
  })

  it('어느 결제 비밀번호인지 좁히지 못하면 password-ambiguous 로 멈춘다', async () => {
    const h = harness({ screens: okScreens, password: 'ambiguous' })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'password-ambiguous' })
  })

  it('비밀번호를 넣었는데 성공 표식이 안 뜨면 재시도 없이 verify-failed', async () => {
    const stuck = [
      screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })]),
      screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])
    ]
    const h = harness({ screens: stuck })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('앱 완료 화면만 보이고 웹 팝업이 성공하지 않으면 실패로 본다', async () => {
    const h = harness({ screens: okScreens, webSuccess: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
  })

  it('성공·실패 모두 app_approve 를 1건만 남긴다', async () => {
    const good = harness({ screens: okScreens })
    await runPayApproval(good.deps, request())
    expect(good.records).toEqual([{ kind: 'app_approve', ok: true }])

    const bad = harness({ screens: okScreens, webSuccess: false })
    await runPayApproval(bad.deps, request())
    expect(bad.records).toEqual([{ kind: 'app_approve', ok: false }])
  })

  it('실패 통지에 스크린샷을 붙이되 비밀번호 화면이면 이미지를 빼고 보낸다', async () => {
    // 일반 화면에서 막힌 경우 — 이미지를 붙인다
    const plain = harness({ screens: [screen('viva.republica.toss', [el(1, '주문 내역')])] })
    await runPayApproval(plain.deps, request())
    expect(plain.notices).toHaveLength(1)
    expect(plain.notices[0].hasImage).toBe(true)

    // 비밀번호 화면에서 막힌 경우 — 이미지 없이 글만 보낸다
    const secret = harness({
      screens: [screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])],
      webSuccess: false,
      screenshotSecret: true
    })
    await runPayApproval(secret.deps, request())
    expect(secret.notices).toHaveLength(1)
    expect(secret.notices[0].hasImage).toBe(false)
  })

  it('같은 요소를 두 번 연속 탭하지 않는다', async () => {
    // 확인 버튼만 계속 보이는 화면 — 한 번 누른 뒤에는 다시 누르지 않는다
    const h = harness({ screens: [screen('viva.republica.toss', [el(1, '결제하기')])] })
    const r = await runPayApproval(h.deps, request())

    expect(h.taps).toHaveLength(1)
    expect(r.ok).toBe(false)
  })

  it('UI 트리로 배치를 못 구하면 Visual 로 받아 입력한다', async () => {
    const h = harness({ screens: okScreens, uiKeypad: null, visualKeypad: fullLayout })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: true })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('두 경로 모두 배치를 못 구하면 사람에게 넘긴다', async () => {
    const handoff = vi.fn(async () => ({ outcome: 'timeout' as const, url: '' }))
    const h = harness({
      screens: [screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])],
      uiKeypad: null,
      visualKeypad: null
    })
    const r = await runPayApproval({ ...h.deps, handoff }, request())

    expect(handoff).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, reason: 'layout-incomplete' })
    expect(h.tapPassword).not.toHaveBeenCalled()
  })
})

describe('phone_approve_payment 도구', () => {
  interface ToolStub {
    name: string
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
  }

  function buildTool(opts: { over?: string | null; result?: PayResult } = {}): {
    tool: ToolStub
    run: ReturnType<typeof vi.fn>
    steps: Array<{ label: string; ok: boolean }>
  } {
    const run = vi.fn(async () => opts.result ?? { ok: true })
    const steps: Array<{ label: string; ok: boolean }> = []
    const built = createPayTool({
      tick: () => opts.over ?? null,
      onStep: (label, ok) => steps.push({ label, ok }),
      run
    })
    return { tool: built as unknown as ToolStub, run, steps }
  }

  const args = {
    provider: 'toss',
    amountKrw: 12_000,
    merchant: '삼바상회',
    methodLabel: '토스페이'
  }

  it('도구 이름은 phone_approve_payment 이며 폰 도구 목록과 분리돼 있다', () => {
    expect(buildTool().tool.name).toBe(PAY_TOOL_NAME)
    expect(PHONE_TOOL_NAMES).not.toContain(PAY_TOOL_NAME)
    expect(SAMBA_TOOL_NAMES).toContain(`mcp__samba__${PAY_TOOL_NAME}`)
  })

  it('실행기 결과를 상태 이름으로만 돌려준다', async () => {
    const good = buildTool()
    expect((await good.tool.handler(args)).content[0].text).toBe('ok')

    const bad = buildTool({ result: { ok: false, reason: 'over-limit' } })
    expect((await bad.tool.handler(args)).content[0].text).toBe('refused: over-limit')
  })

  it('호출 상한에 걸리면 실행기를 부르지 않는다', async () => {
    const t = buildTool({ over: 'refused: tool call limit reached' })
    const out = await t.tool.handler(args)

    expect(out.content[0].text).toContain('limit')
    expect(t.run).not.toHaveBeenCalled()
  })

  it('도구 문맥에 금고가 없다', () => {
    type PayCtxKeys = keyof import('../src/main/agent/tools-phone').PayToolContext
    const hasVault: Extract<PayCtxKeys, 'vault'> extends never ? true : false = true
    expect(hasVault).toBe(true)
  })
})

describe('결제 요청이 푸시 알림으로만 와 있을 때 — 알림창에서 연다', () => {
  const shade = (elements: PhoneElement[]): PhoneScreen => screen('com.android.systemui', elements)
  const tossHome = screen(TOSS.packageName, [el(1, '홈', { clickable: true })])
  const payAsk = screen(TOSS.packageName, [el(2, '결제하기')])
  const keypad = screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })])
  const done = screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])
  const TOSS_PUSH = { title: '무신사 결제하기', text: '알림을 누르고 결제를 완료해주세요.' }

  // 실기 그대로: 카카오톡으로 온 "토스" 채널 메시지(제목이 토스)와 토스 앱의 결제 알림이 함께 떠 있다
  const DUMP = [
    '    NotificationRecord(0x0e5267b9: pkg=com.kakao.talk user=UserHandle{0} id=2 tag=49 importance=4 key=0|com.kakao.talk|2',
    '                android.title=String (토스)',
    '                android.text=String ([토스] 결제 혜택이 시작됐어요.',
    '    NotificationRecord(0x08447035: pkg=viva.republica.toss user=UserHandle{0} id=2010044086 tag=null importance=4',
    '                android.title=String (무신사 결제하기)',
    '                android.text=String (알림을 누르고 결제를 완료해주세요.',
    '    NotificationRecord(0x057392be: pkg=viva.republica.toss user=UserHandle{0} id=511393872 tag=null importance=4',
    '                android.title=null',
    '                android.text=null',
    '    NotificationRecord(0x01: pkg=viva.republica.toss user=UserHandle{0} id=7 tag=null importance=3',
    '                android.title=String (오늘의 혜택)',
    '                android.text=String (만보기 포인트를 받아 가세요)'
  ].join('\n')

  it('parseAppNotifications: 그 앱이 올린 결제 알림만 뽑는다(카카오톡의 "토스" 메시지·토스의 광고 알림 제외)', () => {
    expect(parseAppNotifications(DUMP, 'viva.republica.toss')).toEqual([TOSS_PUSH])
  })

  it('findPayNotification: 제목이 정확히 같은 알림만 고른다 — "토스" 글자가 들어간 남의 알림은 누르지 않는다', () => {
    const s = shade([
      el(1, '카카오톡', { clickable: false }),
      el(2, '토스', { clickable: false }),
      el(3, '[토스] 결제 혜택이 시작됐어요.', { clickable: false }),
      el(4, '토스', { clickable: false }),
      el(5, '무신사 결제하기', { clickable: false }),
      el(6, '알림을 누르고 결제를 완료해주세요.', { clickable: false })
    ])
    expect(findPayNotification(s, [TOSS_PUSH])).toBe(5)
    // 결제 알림 글자가 화면에 없으면 아무것도 고르지 않는다
    expect(
      findPayNotification(shade([el(1, '카카오톡'), el(2, '토스'), el(3, '[토스] 결제 혜택')]), [
        TOSS_PUSH
      ])
    ).toBeUndefined()
    expect(findPayNotification(s, [])).toBeUndefined()
  })

  it('앱을 열어도 누를 것이 없으면 알림창을 내려 그 앱의 결제 알림을 누르고 이어간다', async () => {
    const screens = [
      tossHome,
      tossHome,
      tossHome,
      shade([
        el(2, '토스', { clickable: false }),
        el(3, '[토스] 결제 혜택이 시작됐어요.'),
        el(11, '무신사 결제하기', { clickable: false })
      ]),
      payAsk,
      keypad,
      done,
      done
    ]
    const h = harness({ screens })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async (_serial, pkg) => {
        calls.push(`list:${pkg}`)
        return [TOSS_PUSH]
      }
    }
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(['list:viva.republica.toss', 'open'])
    // 토스 결제 알림(11) → 결제하기(2). 카카오톡의 토스 메시지(3)는 누르지 않았다
    expect(h.taps.map((t) => t[2])).toEqual([11 * 100 + 30, 2 * 100 + 30])
  })

  it('그 앱이 올린 결제 알림이 없으면 알림창을 열지도 않는다', async () => {
    const h = harness({ screens: [tossHome] })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async () => []
    }
    const r = await runPayApproval(h.deps, request())
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
    expect(h.taps).toEqual([])
  })

  it('알림 기록에는 있는데 알림창에서 같은 글자를 못 찾으면 누르지 않고 알림창을 도로 올린다', async () => {
    const h = harness({
      screens: [tossHome, tossHome, tossHome, shade([el(1, '카카오톡'), el(2, '토스')]), tossHome]
    })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async () => [TOSS_PUSH]
    }
    const r = await runPayApproval(h.deps, request())
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['open', 'close'])
    expect(h.taps).toEqual([])
  })
})

describe('첫 결제 상한은 설정값이다', () => {
  const base = {
    amountKrw: 29_960,
    limitKrw: 500_000,
    isFirstRunForCombo: true,
    vaultUnlocked: true
  }

  it('기본값은 첫 결제 상한 없음 — 3만원 첫 결제가 그대로 통과한다(실기: 29,960원이 막혔던 건)', () => {
    expect(checkPaymentGate(base)).toBe('ok')
    expect(checkPaymentGate({ ...base, firstRunLimitKrw: 10_000 })).toBe('first-run-too-large')
  })

  it('설정으로 올리면 통과하고, 0 이면 첫 결제 상한을 끈다(결제 상한은 그대로 본다)', () => {
    expect(checkPaymentGate({ ...base, firstRunLimitKrw: 50_000 })).toBe('ok')
    expect(checkPaymentGate({ ...base, firstRunLimitKrw: 0 })).toBe('ok')
    expect(checkPaymentGate({ ...base, amountKrw: 600_000, firstRunLimitKrw: 0 })).toBe(
      'over-limit'
    )
  })

  it('첫 결제가 아니면 첫 결제 상한과 무관하다', () => {
    expect(checkPaymentGate({ ...base, isFirstRunForCombo: false, firstRunLimitKrw: 1_000 })).toBe(
      'ok'
    )
  })
})

describe('결제 확인 카드는 권한 모드를 따른다', () => {
  const flow = [
    screen(TOSS.packageName, [el(2, '결제하기')]),
    screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })]),
    screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })]),
    screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])
  ]

  it('자동(full) 모드에서는 묻지 않고 진행한다', async () => {
    const h = harness({ screens: flow })
    const r = await runPayApproval(h.deps, request({ confirmFirst: false }))
    expect(r).toEqual({ ok: true })
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('guard 모드(기본)에서는 확인 카드를 한 번 띄운다', async () => {
    const h = harness({ screens: flow })
    await runPayApproval(h.deps, request())
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })
})

describe('토스 앱 잠금 — 앱을 켤 때도 비밀번호를 묻는다', () => {
  const lock = screen(TOSS.packageName, [
    el(1, '앱을 켜려면\n비밀번호를 눌러주세요', { clickable: false })
  ])
  const payAsk = screen(TOSS.packageName, [el(2, '결제하기')])
  const payPw = screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })])
  const done = screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])

  it('잠금 1회 + 결제 1회, 비밀번호를 두 번 넣고 끝까지 간다', async () => {
    const h = harness({ screens: [lock, lock, payAsk, payPw, done, done] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.tapPassword).toHaveBeenCalledTimes(2)
  })

  it('잠금 화면이 한참 뒤에도 그대로면(오답) 다시 넣지 않고 멈춘다', async () => {
    const h = harness({ screens: [lock] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('결제 비밀번호 화면이 두 번째로 보이면 예전처럼 멈춘다(재시도 없음)', async () => {
    const h = harness({ screens: [payAsk, payPw, payPw, payPw] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })
})
