// 변경 로그(outbox) → 원격. 표 단위로 돈다.
//
// 안전 규칙
// - 전송 직전 모든 행에 assertNoPlaintext 를 건다. 한 행이라도 걸리면 그 표는 통째로 보내지 않는다
// - 금고가 잠겨 있으면 vault_items 표만 통째로 건너뛴다(봉투 암호화에 마스터 키가 필요하다)
// - 전송에 실패한 건은 outbox 에 그대로 남는다(오프라인이어도 잃지 않는다)

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import type { Settings } from '../../shared/settings'
import {
  isVaultKeySyncKey,
  SYNCED_SETTING_KEYS,
  type SyncTable,
  type VaultKeyApplyResult,
  type VaultKeySyncKey
} from '../../shared/sync'
import { AuthExpiredError, type RemoteKeyedRow, type RemoteRow, type SyncBackend } from './backend'
import { assertNoPlaintext, PlaintextLeakError } from './guard'
import { SyncLocal } from './local'
import {
  accountToRemote,
  bookmarkToRemote,
  remoteTableOf,
  settingToRemote,
  vaultItemToRemote,
  type AccountSyncRow,
  type BookmarkSyncRow,
  type MapCtx,
  type VaultItemSyncRow
} from './mappers'
import { settingUpdatedAtKey, type OutboxRow, type SyncOutbox } from './outbox'
import { storedWorkspaceRemoteId } from './workspace-id'

/** 설정 읽기·쓰기. SettingsStore 가 그대로 만족한다(테스트에서는 최소 스텁) */
export interface SettingsAccess {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
  /**
   * 원격에서 받은 값을 적용할 때 쓴다. 변경 로그를 남기지 않아 되돌아가는 전송(에코)이 없다.
   * 없으면 set 을 쓴다(테스트용 최소 스텁 호환)
   */
  setFromSync?: (patch: Partial<Settings>) => Settings
}

/** 금고에서 동기화가 필요로 하는 부분만. VaultService 가 그대로 만족한다 */
export interface VaultAccess {
  /** 잠금 해제 상태에서만 마스터 키를 빌려 준다. 잠겨 있으면 null */
  useMasterKey: <T>(fn: (key: Buffer) => T) => T | null
  /**
   * 마스터 키 재료(salt·KDF·검증자)를 읽는다. 값은 설정 store 가 아니라 vault_meta 에서 온다.
   * 금고가 아직 설정 전이면 null. 없으면 키 재료를 올리지 않는다(옛 테스트 스텁 호환)
   */
  readKeyMaterial?: (key: VaultKeySyncKey) => string | null
  /** 원격에서 받은 키 재료를 로컬 금고에 심는다. 없으면 풀에서 무시한다 */
  applyKeyMaterial?: (values: Partial<Record<VaultKeySyncKey, string>>) => VaultKeyApplyResult
}

/**
 * 지금 활성 작업공간. 전환될 수 있으므로 엔진을 다시 세우지 않고 **매 주기 평가**한다 —
 * 예전에는 엔진 생성 시 한 번만 읽어, B 작업공간의 변경이 A 의 uuid 로 올라갔다
 */
export interface WorkspaceRef {
  /** 로컬 DB 의 workspaces.id. 풀로 내려받은 행에 채워 넣는다 */
  localId: number
  /** 원격 uuid. 푸시 payload 와 풀 필터에 쓴다 */
  remoteId: string
}

export interface PushDeps {
  db: Db
  backend: SyncBackend
  outbox: SyncOutbox
  vault: VaultAccess
  settings: SettingsAccess
  userId: string
  /** 매 주기 불린다(작업공간 전환을 그대로 따라간다) */
  workspace: () => WorkspaceRef
}

export interface PushResult {
  sent: number
  failed: number
  skipped: number
}

// 계정을 먼저 올려야 금고 항목의 account_id 가 가리킬 대상이 생긴다
const PUSH_ORDER: SyncTable[] = ['accounts', 'vault_items', 'bookmarks', 'settings']

export async function pushAll(deps: PushDeps): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, skipped: 0 }
  const local = new SyncLocal(deps.db)
  const ctxOf = workspaceResolver(deps)

  for (const table of PUSH_ORDER) {
    const entries = deps.outbox.pendingFor(table)
    if (entries.length === 0) continue
    if (table === 'settings') {
      await pushSettings(deps, local, ctxOf, entries, result)
      continue
    }
    await pushTable(deps, local, ctxOf, table, entries, result)
  }
  return result
}

/** 변경 로그 한 줄 → 그 행을 올릴 때 쓸 매핑 문맥(작업공간 uuid 가 행마다 다를 수 있다) */
type CtxOf = (entry: OutboxRow) => MapCtx

/**
 * 행에 적힌 작업공간(로컬 id)으로 원격 uuid 를 고른다.
 * 예전에는 푸시 시점의 활성 작업공간 uuid 를 모든 대기 행에 찍어, 작업공간을 바꾸기 전에
 * 쌓인 변경이 새 작업공간으로 올라갔다.
 * 작업공간이 비어 있는 옛 행과, uuid 를 아직 정하지 못한 행은 활성 작업공간으로 본다
 */
function workspaceResolver(deps: PushDeps): CtxOf {
  const active = deps.workspace()
  const cache = new Map<number, string>()
  return (entry) => {
    const localId = entry.workspaceId
    if (localId === null || localId === active.localId)
      return { userId: deps.userId, workspaceRemoteId: active.remoteId }
    const cached = cache.get(localId)
    if (cached !== undefined) return { userId: deps.userId, workspaceRemoteId: cached }
    const remoteId = storedWorkspaceRemoteId(deps.db, localId) ?? active.remoteId
    cache.set(localId, remoteId)
    return { userId: deps.userId, workspaceRemoteId: remoteId }
  }
}

/** 전송한 행과 로컬 행을 이어 두었다가, 성공하면 remote_id 를 로컬에 적는다 */
interface Prepared {
  entry: OutboxRow
  row: RemoteRow
  /** upsert 인 경우에만 있다(삭제는 로컬 행이 이미 없다) */
  localId: number | null
}

async function pushTable(
  deps: PushDeps,
  local: SyncLocal,
  ctxOf: CtxOf,
  table: Exclude<SyncTable, 'settings'>,
  entries: OutboxRow[],
  result: PushResult
): Promise<void> {
  const remoteTable = remoteTableOf(table)
  const prepared: Prepared[] = []
  // 로컬 행이 사라졌고 삭제 스냅샷도 없는 건 — 보낼 것이 없으니 로그에서 지운다
  const droppable: number[] = []

  try {
    for (const entry of entries) {
      const built = buildRemote(deps, local, ctxOf(entry), table, entry)
      if (built === 'skip') {
        result.skipped += 1
        continue
      }
      if (built === null) {
        droppable.push(entry.id)
        continue
      }
      assertNoPlaintext(remoteTable, built.row)
      prepared.push(built)
    }
  } catch (e: unknown) {
    // 평문 검사 실패 — 이 표는 한 행도 보내지 않는다. outbox 는 그대로 보존한다
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof PlaintextLeakError) console.error('동기화 중단: 평문 검사 실패', message)
    else console.error('동기화 중단: 원격 행을 만들지 못했습니다', message)
    deps.outbox.markFailed(
      entries.map((r) => r.id),
      message
    )
    result.failed += entries.length
    return
  }

  deps.outbox.clear(droppable)
  if (prepared.length === 0) return

  try {
    await deps.backend.upsert(
      remoteTable,
      prepared.map((p) => p.row)
    )
  } catch (e: unknown) {
    if (e instanceof AuthExpiredError) throw e
    const message = e instanceof Error ? e.message : String(e)
    deps.outbox.markFailed(
      prepared.map((p) => p.entry.id),
      message
    )
    result.failed += prepared.length
    return
  }

  for (const p of prepared) {
    if (p.localId === null) continue
    const remoteId = String(p.row.id)
    if (table === 'accounts') local.setAccountRemoteId(p.localId, remoteId)
    else if (table === 'vault_items') local.setVaultItemRemoteId(p.localId, remoteId)
    else local.setBookmarkRemoteId(p.localId, remoteId)
  }
  deps.outbox.clear(prepared.map((p) => p.entry.id))
  result.sent += prepared.length
}

/**
 * 변경 로그 한 줄을 원격 행으로 바꾼다.
 * - 'skip': 지금은 보낼 수 없다(금고 잠김) — outbox 에 남긴다
 * - null: 보낼 것이 없다 — outbox 에서 지운다
 */
function buildRemote(
  deps: PushDeps,
  local: SyncLocal,
  ctx: MapCtx,
  table: Exclude<SyncTable, 'settings'>,
  entry: OutboxRow
): Prepared | 'skip' | null {
  const rowId = Number(entry.rowId)
  if (table === 'accounts') {
    const row =
      entry.op === 'delete' ? tombstone<AccountSyncRow>(entry) : local.accountForSync(rowId)
    if (!row) return null
    return { entry, row: accountToRemote(row, ctx), localId: entry.op === 'delete' ? null : rowId }
  }
  if (table === 'bookmarks') {
    const row =
      entry.op === 'delete' ? tombstone<BookmarkSyncRow>(entry) : local.bookmarkForSync(rowId)
    if (!row) return null
    return { entry, row: bookmarkToRemote(row, ctx), localId: entry.op === 'delete' ? null : rowId }
  }

  const item =
    entry.op === 'delete' ? tombstone<VaultItemSyncRow>(entry) : local.vaultItemForSync(rowId)
  if (!item) return null
  // 계정에 딸린 항목인데 그 계정이 한 번도 올라간 적이 없다면(동기화를 켜기 전에 만든 계정),
  // 원격 id 만 먼저 붙이고 계정 자체도 다음 주기에 올라가도록 변경 로그에 넣는다
  if (item.accountId !== null && item.accountRemoteId === null) {
    const accountRemoteId = ensureAccountRemoteId(local, item.accountId)
    if (accountRemoteId !== null) {
      item.accountRemoteId = accountRemoteId
      // 계정도 같은 작업공간으로 올라가야 한다 — 변경 로그 행의 작업공간을 그대로 물려준다
      deps.outbox.record('accounts', String(item.accountId), 'upsert', undefined, entry.workspaceId)
    }
  }
  const row = deps.vault.useMasterKey((key) => vaultItemToRemote(item, { ...ctx, key }))
  if (row === null) return 'skip'
  return { entry, row, localId: entry.op === 'delete' ? null : rowId }
}

/** 삭제 스냅샷(payload)을 원래 행 모양으로 되돌린다. 삭제 시각이 비어 있으면 지금으로 본다 */
function tombstone<T extends { deletedAt: number | null }>(entry: OutboxRow): T | null {
  if (!entry.payload) return null
  try {
    const parsed: unknown = JSON.parse(entry.payload)
    if (typeof parsed !== 'object' || parsed === null) return null
    const row = parsed as T
    return { ...row, deletedAt: row.deletedAt ?? entry.createdAt }
  } catch {
    return null
  }
}

async function pushSettings(
  deps: PushDeps,
  local: SyncLocal,
  ctxOf: CtxOf,
  entries: OutboxRow[],
  result: PushResult
): Promise<void> {
  const current = deps.settings.get()
  const rows: RemoteKeyedRow[] = []
  const ids: number[] = []
  const droppable: number[] = []

  try {
    for (const entry of entries) {
      const key = entry.rowId
      if (isVaultKeySyncKey(key)) {
        // 키 재료는 설정 store 에 없다 — 금고(vault_meta)에서 읽는다
        const material = deps.vault.readKeyMaterial?.(key) ?? null
        if (material === null) {
          // 금고가 아직 설정 전이면 올릴 값이 없다(다음 설정 때 다시 기록된다)
          droppable.push(entry.id)
          continue
        }
        const updatedAt = local.getStateNumber(settingUpdatedAtKey(key)) ?? entry.createdAt
        const row = settingToRemote(key, material, updatedAt, ctxOf(entry))
        assertNoPlaintext('settings_sync', row)
        rows.push(row)
        ids.push(entry.id)
        continue
      }
      if (!isSyncedSettingKey(key)) {
        // 조용히 사라지면 "왜 안 올라가지" 를 추적할 수 없다. 키 이름만 남긴다(값은 없다)
        console.warn('동기화 대상이 아닌 설정 키라 변경 로그에서 버립니다', key)
        droppable.push(entry.id)
        continue
      }
      const updatedAt = local.getStateNumber(settingUpdatedAtKey(key)) ?? entry.createdAt
      const row = settingToRemote(key, current[key], updatedAt, ctxOf(entry))
      assertNoPlaintext('settings_sync', row)
      rows.push(row)
      ids.push(entry.id)
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('동기화 중단: 평문 검사 실패', message)
    deps.outbox.markFailed(
      entries.map((r) => r.id),
      message
    )
    result.failed += entries.length
    return
  }

  deps.outbox.clear(droppable)
  if (rows.length === 0) return

  try {
    await deps.backend.upsertKeyed('settings_sync', rows)
  } catch (e: unknown) {
    if (e instanceof AuthExpiredError) throw e
    const message = e instanceof Error ? e.message : String(e)
    deps.outbox.markFailed(ids, message)
    result.failed += rows.length
    return
  }
  deps.outbox.clear(ids)
  result.sent += rows.length
}

function isSyncedSettingKey(key: string): key is (typeof SYNCED_SETTING_KEYS)[number] {
  return (SYNCED_SETTING_KEYS as readonly string[]).includes(key)
}

/** 계정에 원격 id 가 없으면 만들어 붙인다(금고 항목의 account_id 가 가리킬 대상) */
export function ensureAccountRemoteId(local: SyncLocal, accountId: number): string | null {
  return local.ensureAccountRemoteId(accountId, randomUUID)
}
