// 금고(vault) 공용 DTO — 메인·프리로드·렌더러가 함께 쓴다.
// 여기 정의된 어떤 타입에도 비밀값(평문) 필드는 존재하지 않는다.
// 평문은 오직 vault:reveal 응답(string)으로만 렌더러에 전달된다.

// 2단계 Task 11 에서 9종 → 6종으로 재편했다.
// 옛 종류는 migrate-vault-v2 가 LEGACY_TYPE_MAP 으로 변환한다
export type VaultItemType = 'login' | 'password' | 'card' | 'note' | 'identity' | 'document'

export const VAULT_ITEM_TYPES: readonly VaultItemType[] = [
  'login',
  'password',
  'card',
  'note',
  'identity',
  'document'
]

// 옛 9종 → 새 6종 매핑표(마이그레이션·하위 호환 입력 정규화에 함께 쓴다)
export const LEGACY_TYPE_MAP: Record<string, VaultItemType> = {
  login_password: 'login',
  payment_password: 'password',
  card: 'card',
  passport: 'identity',
  id_card: 'identity',
  birth_date: 'identity',
  address: 'identity',
  phone: 'identity',
  custom: 'note'
}

/** 옛 종류 문자열이 들어와도 6종 중 하나로 정규화한다. 모르는 값은 'note' */
export function normalizeItemType(raw: string): VaultItemType {
  if ((VAULT_ITEM_TYPES as readonly string[]).includes(raw)) return raw as VaultItemType
  return LEGACY_TYPE_MAP[raw] ?? 'note'
}

// --- 결제 수단(제공자) ------------------------------------------------------
// 한 계정에 결제 비밀번호가 여러 개일 수 있다(예: 무신사 = 무신사머니·토스페이·
// 카카오페이·페이코). 어느 결제창의 비밀번호인지 구분하는 평문 필드 값이다.
// 'site' 는 사이트 자체 결제(무신사머니·SSG머니처럼 웹에서 끝나는 결제)다
export type PaymentProvider =
  'site' | 'toss' | 'kakao' | 'naver' | 'payco' | 'samsung' | 'apple' | 'other'

export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  'site',
  'toss',
  'kakao',
  'naver',
  'payco',
  'samsung',
  'apple',
  'other'
]

/** 결제 비밀번호 항목에서 제공자를 담는 평문 필드 키 */
export const PAYMENT_PROVIDER_FIELD_KEY = 'payment.provider'

/** 제공자 필드가 없는 옛 항목은 사이트 자체 결제로 본다(마이그레이션 없이 읽기 기본값) */
export const DEFAULT_PAYMENT_PROVIDER: PaymentProvider = 'site'

/** 무엇이 들어와도 8값 중 하나로 맞춘다(기본 'site') */
export function normalizePaymentProvider(raw: string | null | undefined): PaymentProvider {
  if (raw && (PAYMENT_PROVIDERS as readonly string[]).includes(raw)) return raw as PaymentProvider
  return DEFAULT_PAYMENT_PROVIDER
}

// 제공자 필드를 찾기 위한 최소 구조 — StoredSection·VaultSection 둘 다 그대로 들어맞는다
interface ProviderLookupSection {
  fields: readonly { key: string; value?: string }[]
}

/** 섹션 목록에서 결제 제공자를 읽는다. 필드가 없거나 모르는 값이면 'site' */
export function paymentProviderOfSections(
  sections: readonly ProviderLookupSection[]
): PaymentProvider {
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.key === PAYMENT_PROVIDER_FIELD_KEY) return normalizePaymentProvider(field.value)
    }
  }
  return DEFAULT_PAYMENT_PROVIDER
}

export type FieldKind = 'text' | 'secret' | 'url' | 'date' | 'select'

export interface VaultField {
  // 'card.number' 처럼 점으로 구분한다 — fill_secret 의 field 인자와 같은 문자열이다
  key: string
  label: string
  kind: FieldKind
  // kind !== 'secret' 일 때만 평문이 내려간다. secret 필드는 항상 value 가 없다
  value?: string
}

export interface VaultSection {
  key: string
  label: string
  fields: VaultField[]
}

// 목록/상세 메타 — secret 필드는 value 를 절대 포함하지 않는다(reveal 로만 본다)
export interface VaultItemMeta {
  id: number
  accountId: number | null
  type: VaultItemType
  label: string
  sections: VaultSection[]
  updatedAt: number
}

// 항목별 AI 접근 정책. 'inherit' 는 전역 설정(vaultAccessPolicy)을 따른다
export type AgentAccess = 'inherit' | 'always' | 'while_unlocked' | 'never'

export const AGENT_ACCESS_VALUES: readonly AgentAccess[] = [
  'inherit',
  'always',
  'while_unlocked',
  'never'
]

/** DB 문자열이 무엇이든 4값 중 하나로 맞춘다(기본 'inherit') */
export function normalizeAgentAccess(raw: string | null | undefined): AgentAccess {
  if (raw && (AGENT_ACCESS_VALUES as readonly string[]).includes(raw)) return raw as AgentAccess
  return 'inherit'
}

export interface SiteDto {
  id: number
  host: string
  name: string
  loginUrl?: string
}

export interface AccountDto {
  id: number
  siteId: number
  host: string
  label: string
  username: string
  isDefault: boolean
  itemTypes: VaultItemType[]
  // 계정당 여러 URL(옛 sites.loginUrl 이월분 포함)
  urls: string[]
  agentAccess: AgentAccess
  tags: string[]
}

// 페이지 내 자동 채움 피커가 쓰는 최소 정보. 값(비밀번호)은 절대 담기지 않는다.
// username 은 사용자 본인 화면에만 그려지므로 마스킹하지 않는다
export interface PickerAccountDto {
  id: number
  label: string
  username: string
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

// 저장 제안 카드에 쓰는 정보. 비밀번호는 메인에만 남고 여기 담기지 않는다
export interface CapturePromptDto {
  host: string
  username: string
  isNew: boolean
  // 감지 시점에 금고가 잠겨 있었는가. 잠겨 있으면 기존 계정 여부를 알 수 없어
  // isNew 가 항상 true 이므로, UI 는 "새 계정" 대신 중립적인 문구를 쓴다
  locked: boolean
}

// 로그인 성공 감지로 비밀번호가 자동 갱신됐을 때 렌더러에 보내는 토스트용 정보.
// 값(비밀번호)은 담지 않는다. undoToken 은 60초간만 유효하다
export interface PasswordUpdatedDto {
  host: string
  username: string
  undoToken: string
}

// 사용 기록(감사 로그) 한 줄. 값(평문)은 절대 포함하지 않는다
export interface AuditLogDto {
  id: number
  at: number
  itemId: number | null
  // 기록 시점의 계정 id 스냅샷(항목이 지워져도 남는다). 전역 항목·가져오기는 null
  accountId: number | null
  action: string
  jobId: string | null
  source: string
}

// --- 내보내기 ------------------------------------------------------------
// 요청·응답 어디에도 평문 값은 없다. master 는 렌더러 → 메인 한 방향으로만 흐르고
// 메인에서 검증 후 즉시 버려지며, 응답에는 내보낸 항목 "개수" 와 저장 경로만 담긴다
export type ExportFormat = 'csv' | 'json'

export interface ExportRequest {
  format: ExportFormat
  // 마스터 비밀번호 재입력 값
  master: string
}

export interface ExportResult {
  itemCount: number
  filePath: string
}
