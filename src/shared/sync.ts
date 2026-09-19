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

/**
 * 조회 범위. 저장소(금고·북마크)가 어떤 작업공간의 데이터를 보여줄지 가린다.
 * 2b 이전에 만들어진 행은 workspace_id 가 NULL 이고, 이는 "기본 작업공간 것"으로 본다
 * (마이그레이션으로 값을 채우지 않는다).
 */
export interface WorkspaceScope {
  id: number
  /** 이 작업공간이 기본(가장 먼저 만들어진) 작업공간인가 — NULL 행이 여기에 보인다 */
  isDefault: boolean
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

/** 변경 로그 한 줄의 연산 종류 */
export type SyncOp = 'upsert' | 'delete'

/**
 * 쓰기 지점(금고·북마크·설정)이 변경 로그를 남길 때 쓰는 훅.
 * 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태 = 2단계까지의 동작 그대로)
 */
export type OutboxRecorder = (table: SyncTable, rowId: string, op: SyncOp, payload?: string) => void

/**
 * 동기화 대상 설정 키.
 * 기기마다 달라야 하는 값(마지막 URL·패널 폭·이 PC 에서 기억·OCR 사용 여부)은 일부러 뺀다
 */
export const SYNCED_SETTING_KEYS = [
  'model',
  'language',
  'dangerWords',
  'maxToolCalls',
  'permissionMode',
  'finalConfirm',
  'vaultAutoLockMinutes',
  'vaultAccessPolicy',
  'vaultAutoSubmit',
  'vaultKeepSignedIn',
  'vaultAutoUpdatePassword',
  'vaultExcludedHosts',
  'homeUrl',
  'newTabUrl',
  'searchEngine'
] as const

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number]
