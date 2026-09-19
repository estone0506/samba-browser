// 동기화 관련 공유 타입. 메인·렌더러 양쪽에서 쓴다.
// 여기에는 비밀값(토큰·API 키·평문 비밀번호)이 절대 들어가지 않는다

/** 동기화 대상 테이블. 감사 로그(audit_log)는 의도적으로 포함하지 않는다 */
export const SYNC_TABLES = [
  'settings',
  'accounts',
  'vault_items',
  'bookmarks',
  'chats',
  'chat_messages'
] as const
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
  /**
   * 동기화 서버가 내려주는 요금제 값. 스키마 호환을 위해 타입에만 남겨 두고
   * UI·기능 게이트에서는 쓰지 않는다(요금제 구분 폐지)
   */
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
  'agentEffort',
  'vaultAutoLockMinutes',
  'vaultAccessPolicy',
  'vaultAutoSubmit',
  'vaultKeepSignedIn',
  'vaultAutoUpdatePassword',
  'vaultExcludedHosts',
  'homeUrl',
  'newTabUrl',
  'searchEngine',
  // 마우스 제스처 — 기기와 무관한 취향 설정이라 동기화 대상이다
  'mouseGesturesEnabled',
  'mouseGestures',
  // 번역 기본 대상 언어·자동 번역 도메인은 PC 가 달라도 같아야 한다.
  // (번역 캐시는 기기 로컬 파일이라 동기화 대상이 아니다)
  'translateTargetLang',
  'translateAutoDomains',
  // 자동화 플레이북 — 절차는 기기와 무관한 사용자 자산이라 PC 간 같아야 한다.
  // 값은 사용자가 쓴 절차 마크다운일 뿐, 비밀값은 담기지 않는다(계정은 키마스터가 쥔다)
  'playbooks'
] as const

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number]

/**
 * 마스터 키 재료 동기화 키(settings 표에 얹어 보낸다).
 * salt·KDF 파라미터·검증자는 비밀이 아니다 — 이것만으로는 금고를 열 수 없고,
 * 같은 마스터 비밀번호에서 **같은 키를 다시 유도**하는 데만 쓰인다.
 * 값은 설정 store 가 아니라 vault_meta 에서 읽고 쓴다
 */
export const VAULT_KEY_SYNC_KEYS = ['vault.salt', 'vault.kdf', 'vault.verifier'] as const

export type VaultKeySyncKey = (typeof VAULT_KEY_SYNC_KEYS)[number]

export function isVaultKeySyncKey(key: string): key is VaultKeySyncKey {
  return (VAULT_KEY_SYNC_KEYS as readonly string[]).includes(key)
}

/** 원격에서 받은 키 재료를 로컬 금고에 심은 결과 */
export type VaultKeyApplyResult =
  | 'applied' // 설정 전이던 금고에 심었다(이제 '잠김')
  | 'unchanged' // 로컬 값과 같다
  | 'mismatch' // 로컬이 이미 다른 마스터로 설정돼 있다 — 덮지 않는다
  | 'incomplete' // 세 키가 다 오지 않았거나 값이 깨졌다

/** 로컬·원격의 마스터 키 재료가 다를 때 상태 표시줄에 올리는 표식 */
export const VAULT_KEY_MISMATCH_ERROR = 'sync:vaultKeyMismatch'
