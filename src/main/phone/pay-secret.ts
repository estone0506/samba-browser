// 결제 비밀번호 입력. 값이 존재하는 유일한 지점이다 —
// 인자로 받지 않고(호출부가 값을 모르게) 금고에서 직접 읽어 좌표만 탭한다.
// 로그·IPC·모델 어디에도 값이 가지 않는다(라벨은 자리수만 남긴다).
//
// 안전 규칙(3단계 Global Constraints):
//  - 금고가 잠겨 있으면 터치 자체를 거부한다('locked')
//  - 배치가 불완전하면 한 번도 누르지 않는다 — 잘못 누르면 계정이 잠긴다
//  - 재시도는 호출부에서도 하지 않는다(attempts = 1)

import type { KeypadLayout } from '../ai/visual'
import type { PhoneScreen } from '../../shared/phone-snapshot'
import type { VaultItemType, VaultState } from '../../shared/vault'
import { DEFAULT_FIELD_KEY } from '../vault/fields'

/** 이 모듈이 금고에서 쓰는 최소 능력(VaultService 가 그대로 만족한다) */
export interface PaySecretVault {
  state: () => VaultState
  getSecretForFill: (
    accountId: number,
    type: VaultItemType,
    fieldKey?: string,
    jobId?: string
  ) => string | null
}

/** 키패드 배치를 구하는 두 경로. UI 트리를 먼저 보고, 실패하면 Visual 에게 묻는다 */
export interface KeypadSource {
  fromUiTree: (screen: PhoneScreen) => KeypadLayout | null
  fromVisual: (serial: string) => Promise<KeypadLayout | null>
}

export type PaySecretResult = 'ok' | 'locked' | 'not-found' | 'layout-incomplete'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
const SINGLE_DIGIT_RE = /^[0-9]$/

/**
 * 결제 비밀번호를 폰 키패드에 입력한다. 값은 이 함수 밖으로 나가지 않는다 —
 * 인자로도 받지 않고 금고에서 직접 읽으며, 돌려주는 것은 결과 문자열뿐이다
 */
export async function tapPaymentPassword(deps: {
  vault: PaySecretVault
  accountId: number
  jobId?: string
  serial: string
  layout: KeypadLayout
  tap: (serial: string, x: number, y: number) => Promise<void>
  onStep: (label: string, ok: boolean) => void
}): Promise<PaySecretResult> {
  if (deps.vault.state() !== 'unlocked') return 'locked'
  // 금고 항목 종류 'password' = 결제 비밀번호(2단계 LEGACY_TYPE_MAP: payment_password → password)
  const secret = deps.vault.getSecretForFill(
    deps.accountId,
    'password',
    DEFAULT_FIELD_KEY,
    deps.jobId
  )
  if (secret === null || secret === '') return 'not-found'
  const digits = secret.split('')
  // 배치가 불완전하면 누르지 않는다 — 잘못 누르면 계정이 잠긴다
  if (digits.some((d) => deps.layout.digits[d] === undefined)) return 'layout-incomplete'
  for (const d of digits) {
    const point = deps.layout.digits[d]
    await deps.tap(deps.serial, point.x, point.y)
  }
  // 라벨에는 자리수만 남긴다
  deps.onStep(`결제 비밀번호 입력(${digits.length}자리)`, true)
  return 'ok'
}

/**
 * UI 트리에서 숫자 키패드 배치를 읽는다(1순위 경로 — 화면을 밖으로 보내지 않는다).
 * 0~9 가 모두 한 번씩 보일 때만 배치를 돌려준다 — 부분·중복 배치로는 누르지 않는다
 */
export function keypadFromUiTree(screen: PhoneScreen): KeypadLayout | null {
  const digits: Record<string, { x: number; y: number }> = {}
  for (const el of screen.elements) {
    const label = el.text.trim() || (el.contentDesc ?? '').trim()
    if (!SINGLE_DIGIT_RE.test(label)) continue
    // 같은 숫자가 두 칸에 보이면 어느 쪽인지 확정할 수 없으므로 배치 전체를 버린다
    if (digits[label]) return null
    digits[label] = { x: el.center.x, y: el.center.y }
  }
  if (DIGITS.some((d) => digits[d] === undefined)) return null
  return { digits }
}
