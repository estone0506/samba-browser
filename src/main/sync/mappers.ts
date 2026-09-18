// 로컬 행 ↔ 원격 행 변환. 순수 함수만 둔다(DB·네트워크 의존 없음).
//
// 금고 항목이 이 파일의 핵심이다. 로컬 vault_items.fields JSON 은 secret 필드의 암호문과
// url·text 같은 평문 필드가 섞여 있으므로, **JSON 전체를 마스터 키로 한 번 더 감싸(봉투 암호화)**
// 올린다. 서버는 바이트만 본다

import { randomUUID } from 'node:crypto'
import { decrypt, encrypt } from '../vault/crypto'
import type { RemoteKeyedRow, RemoteRow } from './backend'

export interface MapCtx {
  userId: string
  workspaceRemoteId: string
}

/** 금고 항목 동기화 암호문의 AAD. 원격 id 에 묶어 다른 행으로 옮겨 붙일 수 없게 한다 */
export function vaultSyncAad(remoteId: string): string {
  return `sync:vault_items:${remoteId}`
}

/** 표 이름 → 원격 표 이름. guard 가 검사하는 이름과 반드시 같아야 한다 */
export function remoteTableOf(table: string): string {
  return `${table}_sync`
}

// --- 시각 변환 --------------------------------------------------------------

/** 로컬 ms → 원격 timestamptz 문자열 */
export function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

export function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms)
}

/** 원격 timestamptz(문자열·숫자 모두 허용) → 로컬 ms. 못 읽으면 0 */
export function fromIso(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string') return 0
  const t = Date.parse(value)
  return Number.isNaN(t) ? 0 : t
}

export function fromIsoOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const t = fromIso(value)
  return t === 0 ? null : t
}

// --- 계정 ------------------------------------------------------------------

export interface AccountSyncRow {
  id: number
  remoteId: string | null
  host: string
  label: string
  username: string
  isDefault: boolean
  urls: string[]
  agentAccess: string
  tags: string[]
  pausedUntil: number | null
  updatedAt: number
  deletedAt: number | null
}

export function accountToRemote(row: AccountSyncRow, ctx: MapCtx): RemoteRow {
  return {
    id: row.remoteId ?? randomUUID(),
    user_id: ctx.userId,
    workspace_id: ctx.workspaceRemoteId,
    host: row.host,
    label: row.label,
    username: row.username,
    is_default: row.isDefault,
    urls: row.urls,
    agent_access: row.agentAccess,
    tags: row.tags,
    paused_until: toIsoOrNull(row.pausedUntil),
    updated_at: toIso(row.updatedAt),
    deleted_at: toIsoOrNull(row.deletedAt)
  }
}

/** 원격 계정 행 → 로컬에 반영할 값. id(로컬 정수)는 호출부가 찾아 채운다 */
export function accountFromRemote(row: RemoteRow): Omit<AccountSyncRow, 'id'> {
  return {
    remoteId: row.id,
    host: asString(row.host),
    label: asString(row.label),
    username: asString(row.username),
    isDefault: row.is_default === true,
    urls: asStringArray(row.urls),
    agentAccess: asString(row.agent_access) || 'inherit',
    tags: asStringArray(row.tags),
    pausedUntil: fromIsoOrNull(row.paused_until),
    updatedAt: fromIso(row.updated_at),
    deletedAt: fromIsoOrNull(row.deleted_at)
  }
}

// --- 금고 항목 --------------------------------------------------------------

export interface VaultItemSyncRow {
  id: number
  remoteId: string | null
  /** 로컬 계정 id. 원격 행에는 들어가지 않고, 계정의 원격 id 를 찾는 데만 쓴다 */
  accountId: number | null
  accountRemoteId: string | null
  type: string
  label: string
  // 로컬 vault_items.fields 원문(JSON 문자열). 평문 필드가 섞여 있으므로 통째로 암호화한다
  fieldsJson: string
  updatedAt: number
  deletedAt: number | null
}

/**
 * 로컬 항목을 원격 행으로 바꾼다.
 * fields JSON 은 url·text 같은 평문 필드를 포함하므로, 개별 필드 암호문에 더해
 * JSON 전체를 마스터 키로 한 번 더 감싸(봉투 암호화) 올린다
 */
export function vaultItemToRemote(row: VaultItemSyncRow, ctx: MapCtx & { key: Buffer }): RemoteRow {
  const id = row.remoteId ?? randomUUID()
  const aad = vaultSyncAad(id)
  const sealed = encrypt(ctx.key, row.fieldsJson, aad)
  return {
    id,
    user_id: ctx.userId,
    workspace_id: ctx.workspaceRemoteId,
    account_id: row.accountRemoteId,
    type: row.type,
    label: row.label,
    fields_ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    aad,
    updated_at: toIso(row.updatedAt),
    deleted_at: toIsoOrNull(row.deletedAt)
  }
}

/**
 * 원격 금고 행을 복호화해 로컬에 반영할 값으로 바꾼다.
 * 키·AAD 가 맞지 않으면(다른 행으로 옮겨 붙인 암호문 등) 예외를 던진다 —
 * 호출부는 그 행만 건너뛴다. 예외 메시지에는 값도 암호문도 담지 않는다
 */
export function vaultItemFromRemote(
  row: RemoteRow,
  key: Buffer
): Omit<VaultItemSyncRow, 'id' | 'accountId'> & { remoteId: string } {
  const expected = vaultSyncAad(row.id)
  const aad = asString(row.aad)
  if (aad !== expected) throw new Error('AAD 가 원격 id 와 맞지 않습니다')
  const fieldsJson = decrypt(key, toBuffer(row.fields_ciphertext), toBuffer(row.iv), aad)
  return {
    remoteId: row.id,
    accountRemoteId: typeof row.account_id === 'string' ? row.account_id : null,
    type: asString(row.type),
    label: asString(row.label),
    fieldsJson,
    updatedAt: fromIso(row.updated_at),
    deletedAt: fromIsoOrNull(row.deleted_at)
  }
}

// --- 북마크 -----------------------------------------------------------------

export interface BookmarkSyncRow {
  id: number
  remoteId: string | null
  /** 폴더 트리에서 계산한 경로(예: '북마크바/개발'). 루트면 빈 문자열 */
  folderPath: string
  title: string
  url: string
  position: number
  updatedAt: number
  deletedAt: number | null
}

export function bookmarkToRemote(row: BookmarkSyncRow, ctx: MapCtx): RemoteRow {
  return {
    id: row.remoteId ?? randomUUID(),
    user_id: ctx.userId,
    workspace_id: ctx.workspaceRemoteId,
    folder_path: row.folderPath,
    title: row.title,
    url: row.url,
    position: row.position,
    updated_at: toIso(row.updatedAt),
    deleted_at: toIsoOrNull(row.deletedAt)
  }
}

export function bookmarkFromRemote(row: RemoteRow): Omit<BookmarkSyncRow, 'id'> {
  return {
    remoteId: row.id,
    folderPath: asString(row.folder_path),
    title: asString(row.title),
    url: asString(row.url),
    position: typeof row.position === 'number' ? row.position : 0,
    updatedAt: fromIso(row.updated_at),
    deletedAt: fromIsoOrNull(row.deleted_at)
  }
}

// --- 설정 -------------------------------------------------------------------

export interface SettingSyncRow {
  key: string
  value: unknown
  updatedAt: number
  deletedAt: number | null
}

/**
 * 설정은 복합 PK(user_id, workspace_id, key)라 id 컬럼이 없다.
 * 그래서 다른 표와 달리 RemoteKeyedRow 를 쓴다
 */
export function settingToRemote(
  key: string,
  value: unknown,
  updatedAt: number,
  ctx: MapCtx
): RemoteKeyedRow {
  return {
    user_id: ctx.userId,
    workspace_id: ctx.workspaceRemoteId,
    key,
    value,
    updated_at: toIso(updatedAt),
    deleted_at: null
  }
}

export function settingFromRemote(row: RemoteKeyedRow): SettingSyncRow {
  return {
    key: asString(row.key),
    value: row.value,
    updatedAt: fromIso(row.updated_at),
    deletedAt: fromIsoOrNull(row.deleted_at)
  }
}

// --- 값 좁히기 --------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  // jsonb 가 문자열로 돌아오는 드라이버도 있어 한 번 더 시도한다
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
    } catch {
      // 배열이 아니면 빈 배열로 둔다
    }
  }
  return []
}

/** bytea 는 드라이버에 따라 Buffer·Uint8Array 로 온다. 항상 Buffer 로 맞춘다 */
function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new Error('암호문·iv 가 바이트가 아닙니다')
}
