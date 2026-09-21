// 웹 결제 비밀번호 키패드 입력. 값이 존재하는 유일한 지점이다 —
// 폰 쪽 pay-secret.ts 와 같은 규칙: 인자로 받지 않고(호출부가 값을 모르게) 금고에서 직접
// 읽어 숫자 버튼 id 만 누른다. 로그·IPC·모델·onStep 라벨 어디에도 값이 가지 않는다(자리수만).
//
// 안전 규칙:
//  - 금고가 잠겨 있으면 한 번도 누르지 않는다('locked')
//  - 배치가 불완전하면(0~9 가 다 안 보이면) 한 번도 누르지 않는다 — 잘못 누르면 계정이 잠긴다
//  - 자리수를 셀 수 있으면 누른 뒤 늘었는지 확인하고, 안 늘었으면 멈춘다('verify-failed')
//  - 확인·입력완료·결제 버튼은 누르지 않는다. 시도는 1회(재시도는 호출부에서도 하지 않는다)

import type { KeypadLayout } from '../browser/page-bridge'
import type { PaymentProvider, VaultState } from '../../shared/vault'
import type { PaymentSecretResult } from './service'
import { DEFAULT_FIELD_KEY } from './fields'
import { tr } from '../i18n'

/** 이 모듈이 금고에서 쓰는 최소 능력(VaultService 가 그대로 만족한다) */
export interface WebKeypadVault {
  state: () => VaultState
  getPaymentSecretForFill: (args: {
    accountId: number
    provider?: PaymentProvider
    fieldKey?: string
    jobId?: string
  }) => PaymentSecretResult
}

export type WebKeypadResult =
  'ok' | 'locked' | 'not-found' | 'ambiguous' | 'layout-incomplete' | 'verify-failed'

/** 버튼을 누른 뒤 페이지가 반영할 시간(보안 키패드는 누름마다 애니메이션이 있다) */
export const WEB_KEYPAD_TAP_DELAY_MS = 200

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/** 배치에 0~9 가 모두 있는가(순수 함수) */
export function isCompleteLayout(layout: KeypadLayout | null): layout is KeypadLayout {
  return layout !== null && DIGITS.every((d) => typeof layout.digits[d] === 'number')
}

/**
 * 결제 비밀번호를 웹 키패드에 입력한다. 값은 이 함수 밖으로 나가지 않는다 —
 * 인자로도 받지 않고 금고에서 직접 읽으며, 돌려주는 것은 결과 문자열뿐이다
 */
export async function enterWebPaymentPassword(deps: {
  vault: WebKeypadVault
  accountId: number
  /** 어느 결제 수단의 비밀번호인가. 없으면 계정에 하나뿐일 때만 넣는다 */
  provider?: PaymentProvider
  jobId?: string
  layout: KeypadLayout
  /**
   * 매 자리 직전에 배치를 다시 읽는다(선택). 한 글자 누를 때마다 숫자가 재배열되는 키패드에서
   * 처음 읽은 배치로 계속 누르면 오답이 된다 — 다시 읽은 배치가 불완전하면 그 자리에서 멈춘다
   */
  relayout?: () => Promise<KeypadLayout | null>
  /** 숫자 버튼 하나 누르기(pageBridge.click). 결과 문구는 쓰지 않는다 */
  click: (id: number) => Promise<unknown>
  /**
   * 같은 버튼을 진짜 마우스 클릭으로 누르기(좌표 클릭). 보안 키패드가 합성 클릭을 무시할 때만 쓴다 —
   * 자리수가 늘지 않은 것을 확인한 뒤에만 부르므로 같은 숫자가 두 번 들어가지 않는다
   */
  clickNative?: (id: number) => Promise<boolean>
  /** 지금 찍힌 자리수(값은 아니다). 셀 수 없으면 null */
  filled: () => Promise<number | null>
  sleep?: (ms: number) => Promise<void>
  onStep: (label: string, ok: boolean) => void
}): Promise<WebKeypadResult> {
  if (deps.vault.state() !== 'unlocked') return 'locked'
  if (!isCompleteLayout(deps.layout)) return 'layout-incomplete'
  const found = deps.vault.getPaymentSecretForFill({
    accountId: deps.accountId,
    ...(deps.provider === undefined ? {} : { provider: deps.provider }),
    fieldKey: DEFAULT_FIELD_KEY,
    ...(deps.jobId === undefined ? {} : { jobId: deps.jobId })
  })
  if (found.value === null) return found.reason
  if (found.value === '') return 'not-found'
  const digits = found.value.split('')
  // 숫자가 아닌 글자가 섞인 값은 키패드로 넣을 수 없다 — 아무것도 누르지 않는다
  if (digits.some((d) => deps.layout.digits[d] === undefined)) return 'layout-incomplete'
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // 시작 자리수. 이미 몇 자리 찍혀 있으면(사용자가 누르다 멈춘 경우) 거기서 이어 붙이지 않고
  // 검증 기준으로만 쓴다 — 어차피 틀린 값이 되므로 사이트가 지우기를 요구한다
  const before = await deps.filled().catch(() => null)
  let pressed = 0
  let layout: KeypadLayout = deps.layout
  for (const d of digits) {
    // 첫 자리는 방금 읽은 배치를 쓰고, 둘째 자리부터는 다시 읽는다(재배열 키패드)
    if (pressed > 0 && deps.relayout) {
      const fresh = await deps.relayout().catch(() => null)
      if (!isCompleteLayout(fresh)) {
        deps.onStep(tr('vault.webKeypadVerifyFailed', { digits: pressed + 1 }), false)
        return 'verify-failed'
      }
      layout = fresh
    }
    await deps.click(layout.digits[d])
    pressed += 1
    await sleep(WEB_KEYPAD_TAP_DELAY_MS)
    // 자리수를 셀 수 있을 때만 검증한다. 첫 자리부터 늘지 않으면 버튼이 먹지 않은 것이다
    if (before !== null) {
      let now = await deps.filled().catch(() => null)
      // 합성 클릭이 먹지 않았다 — 진짜 마우스 클릭으로 한 번만 다시 누른다
      if (now !== null && now < before + pressed && deps.clickNative) {
        if (await deps.clickNative(layout.digits[d]).catch(() => false)) {
          await sleep(WEB_KEYPAD_TAP_DELAY_MS)
          now = await deps.filled().catch(() => null)
        }
      }
      if (now !== null && now < before + pressed) {
        deps.onStep(tr('vault.webKeypadVerifyFailed', { digits: pressed }), false)
        return 'verify-failed'
      }
    }
  }
  // 라벨에는 자리수만 남긴다
  deps.onStep(tr('vault.webKeypadEntered', { digits: digits.length }), true)
  return 'ok'
}
