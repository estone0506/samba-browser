// 금고(vault) 공용 DTO — 메인·프리로드·렌더러가 함께 쓴다.
// 여기 정의된 어떤 타입에도 비밀값(평문) 필드는 존재하지 않는다.
// 평문은 오직 vault:reveal 응답(string)으로만 렌더러에 전달된다.

export type VaultItemType =
  | 'login_password'
  | 'payment_password'
  | 'card'
  | 'passport'
  | 'id_card'
  | 'birth_date'
  | 'address'
  | 'phone'
  | 'custom'

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
}

// 목록·상세에 쓰는 항목 메타. 값(ciphertext/iv/평문)은 포함하지 않는다
export interface VaultItemMeta {
  id: number
  accountId: number | null
  type: VaultItemType
  label: string
  updatedAt: number
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
