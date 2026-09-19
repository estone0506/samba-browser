// 폰 연동 공용 타입. 메인·렌더러·preload 가 모두 이 파일 하나만 본다.
// (T2 작업 범위: PhoneRepo 가 쓰는 타입만 우선 추가 — 나머지는 T1 이 채운다)

export const PHONE_COUNTRIES = ['KR', 'CN', 'JP'] as const
export type PhoneCountry = (typeof PHONE_COUNTRIES)[number]

export const PHONE_TRANSPORTS = ['usb', 'wifi'] as const
export type PhoneTransport = (typeof PHONE_TRANSPORTS)[number]

// adb 가 보고하는 상태 + 목록에는 있으나 지금 안 보이는 상태(disconnected)
export const PHONE_STATES = ['online', 'unauthorized', 'offline', 'disconnected'] as const
export type PhoneState = (typeof PHONE_STATES)[number]

export type AuthEventKind = 'sms' | 'app_approve' | 'ars'
export type AuthEventMethod = 'sms_query' | 'visual' | 'manual'

// 인증 이벤트. 문자 본문은 담지 않는다 — 추출된 코드와 발신번호 뒷 4자리만 남긴다
export interface AuthEventDto {
  id: number
  jobId: string | null
  phoneId: number | null
  kind: AuthEventKind
  siteHost: string
  ok: boolean
  method: AuthEventMethod
  elapsedMs: number
  // 추출한 인증번호(숫자만) — 본문은 남기지 않는다
  code: string | null
  // 발신번호 뒷 4자리
  senderTail: string | null
  at: number
}
