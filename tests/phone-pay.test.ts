// 간편결제 앱 승인 흐름. 상한 검사·확인 카드·상태 전이와 "재시도 없음" 을 단언한다

import { describe, it, expect, vi } from 'vitest'
import {
  PAY_PROVIDERS,
  checkPaymentGate,
  nextPayState,
  runPayApproval,
  type PayRequest,
  type PayRunDeps
} from '../src/main/phone/pay'
import { DEFAULT_PAYMENT_LIMIT_KRW, FIRST_RUN_LIMIT_KRW } from '../src/shared/phone'
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
    password?: 'ok' | 'locked' | 'not-found' | 'layout-incomplete'
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
    vault: { state: () => 'unlocked', getSecretForFill: () => '149072' },
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

describe('checkPaymentGate', () => {
  const base = {
    amountKrw: 10_000,
    limitKrw: DEFAULT_PAYMENT_LIMIT_KRW,
    isFirstRunForCombo: false,
    vaultUnlocked: true
  }

  it('상한 안이면 ok', () => {
    expect(checkPaymentGate(base)).toBe('ok')
  })

  it('상한을 넘으면 over-limit', () => {
    expect(checkPaymentGate({ ...base, amountKrw: DEFAULT_PAYMENT_LIMIT_KRW + 1 })).toBe(
      'over-limit'
    )
  })

  it('새 조합의 첫 결제가 1만원을 넘으면 first-run-too-large', () => {
    expect(
      checkPaymentGate({
        ...base,
        amountKrw: FIRST_RUN_LIMIT_KRW + 1,
        isFirstRunForCombo: true
      })
    ).toBe('first-run-too-large')
    // 1만원 이하면 통과한다
    expect(
      checkPaymentGate({ ...base, amountKrw: FIRST_RUN_LIMIT_KRW, isFirstRunForCombo: true })
    ).toBe('ok')
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

  it('상한을 넘으면 확인 카드도 띄우지 않고 거부한다', async () => {
    const h = harness({ screens: okScreens })
    const r = await runPayApproval(h.deps, request({ amountKrw: 900_000 }))

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
