// 간편결제 앱 승인 흐름. 웹 결제창이 띄운 앱(토스·페이코·카카오페이·네이버페이)에서
// "결제하기 → 비밀번호 → 완료" 를 따라가고, 웹 팝업의 성공 리다이렉트까지 확인한다.
//
// 안전 규칙(3단계 Global Constraints):
//  - 결제는 권한 모드와 무관하게 확인 카드 1회. full 모드여도 건너뛰지 않는다
//  - 상한 50만원, 새 (사이트 × 결제수단) 조합의 첫 결제는 1만원까지
//  - 비밀번호는 여기서 다루지 않는다 — pay-secret.ts 의 tapPaymentPassword 가 금고에서
//    직접 읽어 좌표만 누른다. 오입력이 의심돼도 재시도하지 않는다(계정 잠금 방지)
//  - 실패 통지의 스크린샷은 비밀번호 화면이면 붙이지 않는다

import {
  DEFAULT_PAYMENT_LIMIT_KRW,
  FIRST_RUN_LIMIT_KRW,
  type AuthEventDto
} from '../../shared/phone'
import { findElement, type PhoneScreen } from '../../shared/phone-snapshot'
import type { PaymentProvider } from '../../shared/vault'
import type { KeypadLayout } from '../ai/visual'
import type { HandoffResult } from '../agent/handoff'
import {
  tapPaymentPassword,
  type KeypadSource,
  type PaySecretResult,
  type PaySecretVault
} from './pay-secret'

export type PayState =
  'idle' | 'await_app' | 'app_steps' | 'password' | 'verify' | 'done' | 'failed'
export type PayProvider = 'toss' | 'payco' | 'kakaopay' | 'naverpay'

export interface PayProviderSpec {
  id: PayProvider
  packageName: string
  deepLink: string
  // 진행 버튼 텍스트 후보(정규식). 사이트·앱별 차이는 데이터로 둔다
  confirmText: RegExp
  // 비밀번호 화면임을 알리는 표식
  passwordHint: RegExp
  successHint: RegExp
}

export const PAY_PROVIDERS: Record<PayProvider, PayProviderSpec> = {
  toss: {
    id: 'toss',
    packageName: 'viva.republica.toss',
    deepLink: 'supertoss://',
    confirmText: /결제하기|확인|다음|동의하고 결제/,
    passwordHint: /비밀번호|간편비밀번호|PIN/,
    successHint: /결제(가)?\s?완료|송금 완료|완료되었습니다/
  },
  payco: {
    id: 'payco',
    packageName: 'com.nhnent.payapp',
    deepLink: 'payco://',
    confirmText: /결제하기|확인|다음/,
    passwordHint: /결제 ?비밀번호|PAYCO 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  },
  kakaopay: {
    id: 'kakaopay',
    packageName: 'com.kakao.talk',
    deepLink: 'kakaotalk://',
    confirmText: /결제하기|확인|다음|동의하고 결제/,
    passwordHint: /결제 ?비밀번호|카카오페이 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  },
  naverpay: {
    id: 'naverpay',
    packageName: 'com.nhn.android.search',
    deepLink: 'naversearchapp://',
    confirmText: /결제하기|확인|다음/,
    passwordHint: /결제 ?비밀번호|네이버페이 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  }
}

/**
 * 결제앱(PayProvider) → 금고 결제 수단(PaymentProvider) 매핑.
 * 사이트 자체 결제(무신사머니·SSG머니 등)는 웹에서 끝나므로 여기 없고 'site' 를 쓴다
 */
export const PAY_APP_TO_PAYMENT_PROVIDER: Record<PayProvider, PaymentProvider> = {
  toss: 'toss',
  payco: 'payco',
  kakaopay: 'kakao',
  naverpay: 'naver'
}

/** 앱 화면을 더듬는 최대 스텝(무한 루프 방지) */
export const MAX_PAY_STEPS = 20
/** 화면이 그대로일 때 다음 확인까지 기다리는 시간 */
export const PAY_POLL_MS = 1000

export type PayGate = 'ok' | 'over-limit' | 'first-run-too-large' | 'vault-locked'

/** 결제를 시작해도 되는지 본다. 금액은 원 단위 정수다 */
export function checkPaymentGate(input: {
  amountKrw: number
  limitKrw: number
  isFirstRunForCombo: boolean
  vaultUnlocked: boolean
}): PayGate {
  if (!(input.amountKrw > 0)) return 'over-limit'
  if (input.amountKrw > input.limitKrw) return 'over-limit'
  // 새 (사이트 × 결제수단) 조합의 첫 자동 결제는 소액만 허용한다
  if (input.isFirstRunForCombo && input.amountKrw > FIRST_RUN_LIMIT_KRW) {
    return 'first-run-too-large'
  }
  // 금고가 잠겨 있으면 비밀번호를 만질 수 없으므로 시작조차 하지 않는다
  if (!input.vaultUnlocked) return 'vault-locked'
  return 'ok'
}

function hasText(screen: PhoneScreen, re: RegExp): boolean {
  return screen.elements.some((e) => re.test(e.text) || re.test(e.contentDesc ?? ''))
}

function findConfirm(screen: PhoneScreen, re: RegExp): number | undefined {
  return screen.elements.find(
    (e) => e.clickable && (re.test(e.text) || re.test(e.contentDesc ?? ''))
  )?.id
}

/** 지금 화면이 비밀번호(보안 키패드) 화면인가. 스크린샷 저장·전송 판정에도 쓴다 */
export function isSecretScreen(screen: PhoneScreen, spec: PayProviderSpec): boolean {
  if (screen.elements.some((e) => e.isSecret)) return true
  return hasText(screen, spec.passwordHint)
}

/** 앱 안에서 화면을 보고 다음 할 일을 정한다 */
function stepInApp(
  screen: PhoneScreen,
  spec: PayProviderSpec
): { state: PayState; tapElementId?: number } {
  // 비밀번호 화면 판정이 가장 먼저다 — 여기서 아무 버튼이나 누르면 안 된다
  if (isSecretScreen(screen, spec)) return { state: 'password' }
  if (hasText(screen, spec.successHint)) return { state: 'verify' }
  const tapElementId = findConfirm(screen, spec.confirmText)
  return tapElementId === undefined ? { state: 'app_steps' } : { state: 'app_steps', tapElementId }
}

/** 화면을 보고 다음 상태를 정하는 순수 전이 함수 */
export function nextPayState(
  state: PayState,
  screen: PhoneScreen,
  spec: PayProviderSpec
): { state: PayState; tapElementId?: number } {
  switch (state) {
    case 'idle':
      return { state: 'await_app' }
    case 'await_app':
      // 앱이 앞으로 나오기 전에는 아무것도 누르지 않는다
      return screen.app === spec.packageName ? stepInApp(screen, spec) : { state: 'await_app' }
    case 'app_steps':
      return stepInApp(screen, spec)
    case 'password':
      return hasText(screen, spec.successHint) ? { state: 'verify' } : { state: 'password' }
    case 'verify':
      return hasText(screen, spec.successHint) ? { state: 'done' } : { state: 'verify' }
    default:
      return { state }
  }
}

export type PayFailReason =
  | PayGate
  | 'declined'
  | 'password-failed'
  // 계정에 결제 비밀번호가 둘 이상인데 어느 것인지 좁히지 못했다(누르지 않고 멈춘다)
  | 'password-ambiguous'
  | 'layout-incomplete'
  | 'verify-failed'
  | 'stuck'
  // 배선부가 실행기에 닿기도 전에 막는 두 가지(계정 특정 실패·연결된 폰 없음)
  | 'no-account'
  | 'no-phone'

export interface PayResult {
  ok: boolean
  reason?: PayFailReason
}

export interface PayRequest {
  provider: PayProvider
  amountKrw: number
  merchant: string
  /** 확인 카드에 보일 결제수단 이름 */
  methodLabel: string
  /** 확인 카드에 보일 폰 별칭 */
  phoneLabel: string
  accountId: number
  phoneId: number | null
  serial: string
  siteHost: string
  jobId?: string
  isFirstRunForCombo: boolean
  /** 설정에서 바꾼 상한. 없으면 기본 50만원 */
  limitKrw?: number
}

/** 실행기가 남기는 인증 이벤트 1건(문자와 같은 표를 쓰되 본문은 없다) */
export type PayRecord = Omit<AuthEventDto, 'id'> & { kind: 'app_approve' }

export interface PayRunDeps {
  phones: {
    screen: (serial: string) => Promise<PhoneScreen>
    tap: (serial: string, x: number, y: number) => Promise<void>
    screenshot: (serial: string) => Promise<{ png: Buffer; secret: boolean }>
  }
  /** 딥링크로 결제 앱을 앞으로 부른다(배선부가 am start 로 채운다) */
  launchApp: (serial: string, deepLink: string) => Promise<void>
  /** 결제 확인 카드. 권한 모드와 무관하게 정확히 1회 부른다 */
  confirm: (action: string) => Promise<boolean>
  /** 비밀번호를 읽을 금고. 값은 tapPaymentPassword 안에서만 복호화된다 */
  vault: PaySecretVault
  vaultUnlocked: () => boolean
  keypad: KeypadSource
  /** 웹 결제창(팝업)이 성공 주소로 넘어갔는가 */
  webSuccess: () => Promise<boolean>
  record: (e: PayRecord) => void
  /** 실패 알림. 비밀번호 화면이면 png 를 넘기지 않는다 */
  notify: (message: string, png?: Buffer) => void
  onStep: (label: string, ok: boolean) => void
  now: () => number
  sleep?: (ms: number) => Promise<void>
  /** 캡차 넘김과 같은 카드로 사람에게 넘긴다(키패드를 못 읽었을 때) */
  handoff?: (req: {
    matched: string
    currentUrl: () => string
    stillBlocked: () => Promise<boolean>
  }) => Promise<HandoffResult>
  /** 테스트에서 바꿔 끼우는 비밀번호 입력기. 기본값은 pay-secret 의 구현이다 */
  tapPassword?: typeof tapPaymentPassword
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

/** 12000 → '12,000' */
export function formatKrw(amount: number): string {
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 확인 카드 문구 — 금액·가맹점·결제수단·폰 별칭을 모두 보여 준다 */
export function payConfirmText(req: PayRequest): string {
  return `결제 승인: ${formatKrw(req.amountKrw)}원 · ${req.merchant} · ${req.methodLabel} · ${req.phoneLabel}`
}

const GATE_LABEL: Record<Exclude<PayGate, 'ok'>, string> = {
  'over-limit': '결제 상한 초과',
  'first-run-too-large': '첫 결제 금액 초과',
  'vault-locked': '키마스터 잠김'
}

const SECRET_FAIL: Record<Exclude<PaySecretResult, 'ok'>, PayFailReason> = {
  locked: 'vault-locked',
  'not-found': 'password-failed',
  ambiguous: 'password-ambiguous',
  'layout-incomplete': 'layout-incomplete'
}

export async function runPayApproval(deps: PayRunDeps, req: PayRequest): Promise<PayResult> {
  const spec = PAY_PROVIDERS[req.provider]
  const sleep = deps.sleep ?? defaultSleep
  const tapPassword = deps.tapPassword ?? tapPaymentPassword
  const startedAt = deps.now()
  // 키패드를 Visual 로 읽었는지 — 인증 이벤트의 method 에 남긴다
  let usedVisual = false

  const finish = (ok: boolean, reason?: PayFailReason): PayResult => {
    const at = deps.now()
    deps.record({
      kind: 'app_approve',
      jobId: req.jobId ?? null,
      phoneId: req.phoneId,
      siteHost: req.siteHost,
      ok,
      method: usedVisual ? 'visual' : 'manual',
      elapsedMs: at - startedAt,
      // 결제 승인에는 인증번호도 발신번호도 없다
      code: null,
      senderTail: null,
      at
    })
    return ok ? { ok: true } : { ok: false, reason }
  }

  /** 실패 통지 + 기록. 비밀번호 화면이면 이미지를 아예 만들지 않는다 */
  const fail = async (reason: PayFailReason, screen: PhoneScreen | null): Promise<PayResult> => {
    deps.onStep(`결제 실패: ${reason}`, false)
    const message = `결제를 끝내지 못했습니다(${reason}). 폰에서 직접 확인해 주세요.`
    if (screen && isSecretScreen(screen, spec)) {
      deps.notify(message)
      return finish(false, reason)
    }
    try {
      const shot = await deps.phones.screenshot(req.serial)
      if (shot.secret || shot.png.length === 0) deps.notify(message)
      else deps.notify(message, shot.png)
    } catch {
      // 캡처가 실패해도 통지는 남긴다(오류 본문에는 화면이 실릴 수 있어 남기지 않는다)
      deps.notify(message)
    }
    return finish(false, reason)
  }

  /** 키패드를 못 읽으면 누르지 않고 사람에게 넘긴다(캡차 넘김 카드 재사용) */
  const handOff = async (screen: PhoneScreen): Promise<PayResult> => {
    if (deps.handoff) {
      const result = await deps.handoff({
        matched: '결제 비밀번호 키패드',
        currentUrl: () => req.siteHost,
        // 비밀번호 화면이 사라지면 사용자가 직접 끝낸 것으로 본다
        stillBlocked: async () => isSecretScreen(await deps.phones.screen(req.serial), spec)
      })
      if (result.outcome === 'resumed' && (await deps.webSuccess())) {
        deps.onStep('결제 완료(사용자 확인)', true)
        return finish(true)
      }
    }
    return fail('layout-incomplete', screen)
  }

  const gate = checkPaymentGate({
    amountKrw: req.amountKrw,
    limitKrw: req.limitKrw ?? DEFAULT_PAYMENT_LIMIT_KRW,
    isFirstRunForCombo: req.isFirstRunForCombo,
    vaultUnlocked: deps.vaultUnlocked()
  })
  if (gate !== 'ok') {
    // 앱을 열기 전이라 화면도 없다 — 카드도 띄우지 않고 사유만 남긴다
    deps.onStep(`결제 거부: ${GATE_LABEL[gate]}`, false)
    return finish(false, gate)
  }

  // 권한 모드와 무관하게 확인 카드 1회
  if (!(await deps.confirm(payConfirmText(req)))) {
    deps.onStep('결제 확인 거부', false)
    return finish(false, 'declined')
  }

  await deps.launchApp(req.serial, spec.deepLink)

  let state: PayState = 'await_app'
  let lastTapped: number | null = null
  let passwordTried = false
  let screen: PhoneScreen | null = null

  for (let i = 0; i < MAX_PAY_STEPS && state !== 'done'; i++) {
    screen = await deps.phones.screen(req.serial)
    const next = nextPayState(state, screen, spec)
    state = next.state

    if (state === 'password') {
      // 재시도하지 않는다 — 두 번째로 비밀번호 화면이 보이면 잘못 눌린 것으로 본다
      if (passwordTried) return fail('verify-failed', screen)
      passwordTried = true
      const layout = await resolveKeypad(deps, screen, req.serial, (v) => (usedVisual = v))
      if (!layout) return handOff(screen)
      const r = await tapPassword({
        vault: deps.vault,
        accountId: req.accountId,
        provider: PAY_APP_TO_PAYMENT_PROVIDER[req.provider],
        ...(req.jobId === undefined ? {} : { jobId: req.jobId }),
        serial: req.serial,
        layout,
        tap: deps.phones.tap,
        onStep: deps.onStep
      })
      if (r !== 'ok') return fail(SECRET_FAIL[r], screen)
      state = 'verify'
      await sleep(PAY_POLL_MS)
      continue
    }

    // 같은 요소를 두 번 연속 누르지 않는다(무한 탭 방지)
    if (next.tapElementId !== undefined && next.tapElementId !== lastTapped) {
      const el = findElement(screen, next.tapElementId)
      if (el) {
        lastTapped = next.tapElementId
        await deps.phones.tap(req.serial, el.center.x, el.center.y)
        continue
      }
    }
    await sleep(PAY_POLL_MS)
  }

  if (state !== 'done') return fail(passwordTried ? 'verify-failed' : 'stuck', screen)
  // 앱 완료 화면만으로는 부족하다 — 웹 팝업이 성공 주소로 넘어갔는지도 확인한다
  if (!(await deps.webSuccess())) return fail('verify-failed', screen)
  deps.onStep('결제 완료', true)
  return finish(true)
}

/** 키패드 배치: UI 트리 우선, 실패하면 Visual 에게 위치만 묻는다 */
async function resolveKeypad(
  deps: PayRunDeps,
  screen: PhoneScreen,
  serial: string,
  markVisual: (v: boolean) => void
): Promise<KeypadLayout | null> {
  const fromTree = deps.keypad.fromUiTree(screen)
  if (fromTree) return fromTree
  markVisual(true)
  return deps.keypad.fromVisual(serial)
}
