// 폰 화면의 순수 표시 로직. React·window 를 쓰지 않아 그대로 테스트할 수 있다

import {
  PHONE_LIMIT,
  type PhoneCountry,
  type PhoneDto,
  type PhoneState,
  type PhoneTransport,
  type ScreenMode
} from '@shared/phone'

/** 화면에 한 번에 보여 주는 폰 카드 수(동시 연결 상한과 같다) */
export const PHONE_GRID_MAX = PHONE_LIMIT

/** 배지 색조 — StatusBadge 의 tone 과 같은 값 집합을 쓴다 */
export type PhoneBadgeTone = 'neutral' | 'strong' | 'warn'

/** 연결 상태 → 배지 색조. 연결됨만 강조하고 승인 대기·끊김은 경고로 본다 */
export function phoneStateTone(state: PhoneState): PhoneBadgeTone {
  if (state === 'online') return 'strong'
  if (state === 'unauthorized') return 'warn'
  return 'neutral'
}

/** 연결 상태 → i18n 키 */
export function phoneStateLabelKey(state: PhoneState): string {
  return `phone.state.${state}`
}

/** 연결 상태 점 색. 브랜드 컬러 없이 회색·검정 계열만 쓴다 */
export function phoneStateDotClass(state: PhoneState): string {
  if (state === 'online') return 'bg-[var(--text)]'
  if (state === 'unauthorized') return 'bg-[#b91c1c]'
  return 'bg-[var(--line)]'
}

/** 끊긴 폰은 카드 전체를 회색 처리한다 */
export function isPhoneDimmed(state: PhoneState): boolean {
  return state === 'offline' || state === 'disconnected'
}

/** "재연결" 버튼을 보여 줄 상태인가 */
export function canRecover(state: PhoneState): boolean {
  return isPhoneDimmed(state)
}

/** 전송 방식 → i18n 키(USB/WiFi) */
export function transportLabelKey(transport: PhoneTransport): string {
  return `phone.transport.${transport}`
}

/** 국가 배지 문구는 코드 그대로(KR/CN/JP) 쓴다 */
export function countryBadge(country: PhoneCountry): string {
  return country
}

/** 간이 화면으로 내려간 폰에만 배지를 단다. 그 밖에는 null */
export function screenBadgeKey(screenMode: ScreenMode | null): string | null {
  return screenMode === 'still' ? 'phone.badge.still' : null
}

/** 문자 조회 시험 결과 → i18n 키. 아직 시험 전이면 null */
export function smsBadgeKey(smsQueryOk: boolean | null): string | null {
  if (smsQueryOk === null) return null
  return smsQueryOk ? 'phone.badge.smsOk' : 'phone.badge.smsBlocked'
}

/** 목록 정렬 — 연결된 폰 먼저, 같은 상태면 별칭 가나다순 */
const STATE_ORDER: Record<PhoneState, number> = {
  online: 0,
  unauthorized: 1,
  offline: 2,
  disconnected: 3
}

export function sortPhones(list: readonly PhoneDto[]): PhoneDto[] {
  return [...list].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.label.localeCompare(b.label)
  )
}

/** 수동 조작 패드 버튼 — adb keyevent 이름과 i18n 키 */
export const PHONE_PAD_KEYS = [
  { key: 'BACK', labelKey: 'phone.pad.back' },
  { key: 'HOME', labelKey: 'phone.pad.home' },
  { key: 'APP_SWITCH', labelKey: 'phone.pad.recents' },
  { key: 'POWER', labelKey: 'phone.pad.power' }
] as const

export interface ViewRect {
  width: number
  height: number
}

/** 화면 위 좌표 → 0~1 비율. 실제 폰 해상도는 메인만 알고 있으므로 비율만 넘긴다 */
export function toViewRatio(x: number, y: number, rect: ViewRect): { rx: number; ry: number } {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  return {
    rx: clamp(rect.width > 0 ? x / rect.width : 0),
    ry: clamp(rect.height > 0 ? y / rect.height : 0)
  }
}

/** 누른 곳과 뗀 곳이 이 픽셀 이하로 떨어져 있으면 탭으로 본다 */
export const SWIPE_THRESHOLD_PX = 8

export function isSwipe(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.hypot(x2 - x1, y2 - y1) > SWIPE_THRESHOLD_PX
}

/** 동시 연결 상한(3대)을 넘겼는가. 넘기면 설정에 안내를 띄운다 */
export function isOverPhoneLimit(count: number): boolean {
  return count > PHONE_LIMIT
}
