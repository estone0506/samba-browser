// 동기화 관련 공유 타입. 메인·렌더러 양쪽에서 쓴다.
// 여기에는 비밀값(토큰·API 키·평문 비밀번호)이 절대 들어가지 않는다

/** 동기화 대상 테이블. 감사 로그(audit_log)는 의도적으로 포함하지 않는다 */
export const SYNC_TABLES = ['settings', 'accounts', 'vault_items', 'bookmarks'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

/** 렌더러 상태 표시줄에 그대로 쓰이는 동기화 상태 */
export interface SyncStatus {
  online: boolean
  /** 아직 서버로 보내지 못한 변경 개수 */
  pending: number
  lastPulledAt: number | null
  lastError?: string
}

/** 로그인·기기 상태. 토큰은 절대 포함하지 않는다 */
export interface AuthState {
  signedIn: boolean
  email?: string
  plan: 'free' | 'pro'
  deviceId: string | null
  /** .env 가 채워져 있는가 */
  configured: boolean
}

/** 설정 화면의 기기 목록 한 줄 */
export interface DeviceDto {
  id: string
  name: string
  os: string
  appVersion: string
  lastSeenAt: number
  revokedAt: number | null
  /** 지금 이 PC 인가 */
  isCurrent: boolean
}

/** 작업공간 한 줄. id 는 로컬 DB 의 정수, remoteId 는 원격 uuid */
export interface WorkspaceDto {
  id: number
  remoteId: string | null
  name: string
  color: string | null
  position: number
  isActive: boolean
}
