// 폰 연동 공용 타입·상수. 메인·렌더러·preload 가 모두 이 파일 하나만 본다

export const PHONE_COUNTRIES = ['KR', 'CN', 'JP'] as const
export type PhoneCountry = (typeof PHONE_COUNTRIES)[number]

export const PHONE_TRANSPORTS = ['usb', 'wifi'] as const
export type PhoneTransport = (typeof PHONE_TRANSPORTS)[number]

// adb 가 보고하는 상태 + 목록에는 있으나 지금 안 보이는 상태(disconnected)
export const PHONE_STATES = ['online', 'unauthorized', 'offline', 'disconnected'] as const
export type PhoneState = (typeof PHONE_STATES)[number]

// 화면 전송 방식: 동영상(h264) · 간이 화면(주기 스크린샷)
export const SCREEN_MODES = ['video', 'still'] as const
export type ScreenMode = (typeof SCREEN_MODES)[number]

export interface PhoneDto {
  id: number
  serial: string
  label: string
  country: PhoneCountry
  transport: PhoneTransport
  wifiAddress: string | null
  model: string
  state: PhoneState
  // 문자 DB 조회가 되는 폰인가. null 은 아직 시험 조회 전
  smsQueryOk: boolean | null
  lastSeenAt: number
  // 지금 이 폰의 화면을 어떤 방식으로 보내고 있는가(안 보내면 null)
  screenMode: ScreenMode | null
}

// 목록 통지(메인 → 렌더러). warning 은 연결 상한 초과처럼 사용자가 알아야 할 때만 온다
export interface PhoneUpdatedDto {
  list: PhoneDto[]
  warning?: string
}

export type AuthEventKind = 'sms' | 'app_approve' | 'ars'
export type AuthEventMethod = 'sms_query' | 'visual' | 'manual'

export interface AuthEventDto {
  id: number
  jobId: string | null
  phoneId: number | null
  kind: AuthEventKind
  siteHost: string
  ok: boolean
  method: AuthEventMethod
  elapsedMs: number
  at: number
}

// 인증 대기 알림(메인 → 렌더러). 해당 폰 카드를 펼치고 테두리를 강조한다
export interface PhoneAuthWaitingDto {
  waiting: boolean
  kind: AuthEventKind
  siteHost: string
  // 인증을 받기로 배정된 폰(없으면 3대 동시 감시)
  phoneId: number | null
}

// --- 상수(스펙 "핵심 결정" 의 값) -------------------------------------------
/** adb devices 폴링 주기 5초 */
export const DEVICE_POLL_INTERVAL_MS = 5000
/** 문자함 폴링 주기 1초 — 인증 대기 중에만 돈다 */
export const SMS_POLL_INTERVAL_MS = 1000
/** 인증 대기 상한 3분(PRD §9) */
export const AUTH_TIMEOUT_MS = 3 * 60 * 1000
/** 인증번호로 인정하는 문자 수신 최대 경과 시간 3분 */
export const SMS_RECENT_MS = 3 * 60 * 1000
/** Pro 요금제 폰 연결 상한 3대 */
export const PHONE_LIMIT_PRO = 3
/** 화면 해상도 선택지(긴 변 기준) */
export const SCREEN_SIZES = [720, 1080] as const
export type ScreenSize = (typeof SCREEN_SIZES)[number]
/** 화면 프레임률 선택지 */
export const SCREEN_FPS = [10, 15, 30] as const
export type ScreenFps = (typeof SCREEN_FPS)[number]
/** 결제 상한 기본값(원) */
export const DEFAULT_PAYMENT_LIMIT_KRW = 500_000
/** 새 (사이트 × 결제수단) 조합의 첫 자동 결제 상한(원) */
export const FIRST_RUN_LIMIT_KRW = 10_000

export function isPhoneCountry(v: unknown): v is PhoneCountry {
  return typeof v === 'string' && (PHONE_COUNTRIES as readonly string[]).includes(v)
}
