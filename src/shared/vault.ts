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
}
