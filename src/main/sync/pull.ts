// 원격 → 로컬. 표 단위로 읽어 병합 규칙(merge.ts)을 적용한다.
//
// 안전 규칙
// - 금고 항목은 마스터 키로만 열 수 있다. 잠겨 있으면 그 표를 통째로 건너뛴다
// - 복호화에 실패한 행은 **그 행만** 건너뛰고, 로그에 값도 암호문도 남기지 않는다
// - 감사 로그(audit_log)는 어떤 경로로도 건드리지 않는다

import { bookmarkKey, decideLww, type Syncable } from './merge'
import { SyncLocal } from './local'
import {
  accountFromRemote,
  bookmarkFromRemote,
  remoteTableOf,
  settingFromRemote,
  vaultItemFromRemote
} from './mappers'
import { settingUpdatedAtKey } from './outbox'
import { SYNCED_SETTING_KEYS } from '../../shared/sync'
import { parseSettings, type Settings } from '../../shared/settings'
import type { PushDeps } from './push'

export type PullDeps = PushDeps

export interface PullResult {
  applied: number
  conflicts: number
  pruned: number
}

/**
 * 2b 초기의 단일 커서. 지금은 (작업공간, 표) 별 커서로 나뉘었고, 이 값은 새 커서가 아직 없는
 * 옛 DB 의 출발점으로만 읽는다(더 이상 쓰지 않는다)
 */
export const PULL_CURSOR_KEY = 'pullCursor'

/**
 * 다음 풀에서 이 (작업공간, 표) 를 어디부터 읽을지(원격 updated_at 의 최대값).
 * 커서에 작업공간 축이 없으면, A 에서 커서가 T 까지 전진한 뒤 B 로 옮겼을 때
 * B 의 updated_at ≤ T 인 행이 영영 내려오지 않는다
 */
export function pullCursorKey(workspaceLocalId: number, table: PullTable): string {
  return `pullCursor:${workspaceLocalId}:${table}`
}

/** 작업공간 축이 없던 시절의 표별 커서 키(옛 DB 승계용) */
export function legacyTableCursorKey(table: PullTable): string {
  return `pullCursor:${table}`
}

/** 마지막으로 풀에 성공한 시각(로컬 시계). 상태 표시줄에 그대로 보여 준다 */
export const LAST_PULLED_AT_KEY = 'lastPulledAt'

/** 풀이 도는 표. 커서를 표마다 따로 센다 */
export type PullTable = 'accounts' | 'vault_items' | 'bookmarks' | 'settings'

/**
 * 한 표에서 본 행들. null 이면 이번 주기에 그 표를 읽지 못했다는 뜻이다.
 * 커서를 하나만 쓰면 금고가 잠겨 vault_items 를 통째로 건너뛴 주기에도 다른 표의
 * updated_at 때문에 커서가 전진해, 잠금 해제 후 그 구간의 금고 행이 영영 내려오지 않았다
 */
type Seen = { updatedAt: number }[] | null

export async function pullAll(deps: PullDeps): Promise<PullResult> {
  // 내려받은 행에 지금 작업공간을 찍어 둔다 — 그러지 않으면 비기본 작업공간에서 보이지 않는다
  const workspaceLocalId = deps.workspace().localId
  const local = new SyncLocal(deps.db, workspaceLocalId)
  const result: PullResult = { applied: 0, conflicts: 0, pruned: 0 }
  // 단일 커서만 있던 옛 DB 는 그 자리에서 이어 간다
  const legacy = local.getStateNumber(PULL_CURSOR_KEY) ?? 0

  const step = async (table: PullTable, fn: (since: number) => Promise<Seen>): Promise<void> => {
    const key = pullCursorKey(workspaceLocalId, table)
    // 승계 순서: (작업공간, 표) → 표만 있던 커서 → 단일 커서
    const own = local.getStateNumber(key)
    const since = own ?? local.getStateNumber(legacyTableCursorKey(table)) ?? legacy
    const seen = await fn(since)
    // 건너뛴 표는 커서를 두고 간다 — 다음 주기에 같은 구간을 다시 본다
    if (seen === null) return
    let next = since
    for (const row of seen) if (row.updatedAt > next) next = row.updatedAt
    // 옛 키에서 물려받았으면 값이 그대로여도 새 키에 한 번 적어 둔다(승계 완료)
    if (next > since || own === null) local.setStateNumber(key, next)
  }

  await step('accounts', (since) => pullAccounts(deps, local, since, result))
  await step('vault_items', (since) => pullVaultItems(deps, local, since, result))
  await step('bookmarks', (since) => pullBookmarks(deps, local, since, result))
  await step('settings', (since) => pullSettings(deps, local, since, result))

  result.pruned = local.pruneExpiredTombstones(Date.now())
  local.setStateNumber(LAST_PULLED_AT_KEY, Date.now())
  return result
}

/**
 * 로컬·원격 중 누가 이겼는지 판정한다.
 * 로컬이 이기면 충돌로 센다 — 로컬 값이 그대로 남고, 다음 푸시가 원격을 덮는다
 */
function wins(localRow: Syncable | null, remoteRow: Syncable, result: PullResult): boolean {
  const decision = decideLww(localRow, remoteRow)
  if (decision === 'remote') return true
  if (decision === 'local') result.conflicts += 1
  // 같은 시각이면 굳이 덮어쓰지 않는다
  return false
}

function toSyncable(row: {
  remoteId?: string | null
  updatedAt: number
  deletedAt: number | null
}): Syncable {
  return { remoteId: row.remoteId ?? '', updatedAt: row.updatedAt, deletedAt: row.deletedAt }
}

async function pullAccounts(
  deps: PullDeps,
  local: SyncLocal,
  since: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(remoteTableOf('accounts'), since, workspaceOf(deps))
  const seen: { updatedAt: number }[] = []

  for (const raw of rows) {
    const remote = accountFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt })
    // 원격 id 로 먼저 찾고, 처음 합치는 기기라면 (host, username) 으로 짝을 맞춘다
    const localId =
      (remote.remoteId ? local.accountIdByRemote(remote.remoteId) : null) ??
      local.accountIdByHostUsername(remote.host, remote.username)

    if (localId === null) {
      // 원격에서 이미 지워진 행은 로컬에 되살리지 않는다
      if (remote.deletedAt !== null) continue
      local.applyAccount(remote, null)
      result.applied += 1
      continue
    }
    const current = local.accountForSync(localId)
    if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
      local.applyAccount(remote, localId)
      result.applied += 1
    } else if (current && current.remoteId === null && remote.remoteId) {
      // 로컬이 이겼어도 어느 원격 행과 짝인지는 기억해 둔다
      local.setAccountRemoteId(localId, remote.remoteId)
    }
  }
  return seen
}

async function pullVaultItems(
  deps: PullDeps,
  local: SyncLocal,
  since: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(remoteTableOf('vault_items'), since, workspaceOf(deps))
  if (rows.length === 0) return []

  // 금고가 잠겨 있으면 복호화할 수 없다 — 커서도 올리지 않고 다음 주기에 다시 본다
  const seen = deps.vault.useMasterKey((key) => {
    const applied: { updatedAt: number }[] = []
    for (const raw of rows) {
      let remote: ReturnType<typeof vaultItemFromRemote>
      try {
        remote = vaultItemFromRemote(raw, key)
      } catch {
        // 값도 암호문도 남기지 않는다 — 어느 행인지만 남긴다
        console.warn('금고 항목 복호화 실패(건너뜀)', raw.id)
        continue
      }
      applied.push({ updatedAt: remote.updatedAt })
      const localId = local.vaultItemIdByRemote(remote.remoteId)
      if (localId === null) {
        if (remote.deletedAt !== null) continue
        local.applyVaultItem(remote, null)
        result.applied += 1
        continue
      }
      const current = local.vaultItemForSync(localId)
      if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
        local.applyVaultItem(remote, localId)
        result.applied += 1
      }
    }
    return applied
  })
  // null 이면 금고가 잠겨 한 행도 보지 못했다 — 호출부가 커서를 그대로 둔다
  return seen
}

async function pullBookmarks(
  deps: PullDeps,
  local: SyncLocal,
  since: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(remoteTableOf('bookmarks'), since, workspaceOf(deps))
  if (rows.length === 0) return []

  // 북마크는 합집합이다. 같은 (폴더 경로, URL) 만 한 개로 합치고 나머지는 양쪽 다 남는다
  const locals = local.listBookmarksForSync()
  const byKey = new Map(locals.map((b) => [bookmarkKey(b), b]))
  const seen: { updatedAt: number }[] = []

  for (const raw of rows) {
    const remote = bookmarkFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt })
    const matched =
      locals.find((b) => b.remoteId !== null && b.remoteId === remote.remoteId) ??
      byKey.get(bookmarkKey(remote)) ??
      null

    if (!matched) {
      if (remote.deletedAt !== null) continue
      local.applyBookmark(remote, null)
      result.applied += 1
      continue
    }
    if (wins(toSyncable(matched), toSyncable(remote), result)) {
      local.applyBookmark(remote, matched.id)
      result.applied += 1
    } else if (matched.remoteId === null && remote.remoteId) {
      local.setBookmarkRemoteId(matched.id, remote.remoteId)
    }
  }
  return seen
}

async function pullSettings(
  deps: PullDeps,
  local: SyncLocal,
  since: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.selectKeyed('settings_sync', since, workspaceOf(deps))
  const seen: { updatedAt: number }[] = []

  for (const raw of rows) {
    const remote = settingFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt })
    if (!isSyncedSettingKey(remote.key)) continue
    // 설정은 config.json 에 있어 행 단위 수정 시각이 없다. sync_state 에 키별로 따로 적어 둔다
    const localUpdatedAt = local.getStateNumber(settingUpdatedAtKey(remote.key)) ?? 0
    if (remote.updatedAt <= localUpdatedAt) {
      if (localUpdatedAt > remote.updatedAt) result.conflicts += 1
      continue
    }
    // 손상·조작된 값이 들어와도 zod 스키마가 필드별 기본값으로 되돌린다
    const merged = parseSettings({ ...deps.settings.get(), [remote.key]: remote.value })
    applyFromSync(deps, { [remote.key]: merged[remote.key] } as Partial<Settings>)
    local.setStateNumber(settingUpdatedAtKey(remote.key), remote.updatedAt)
    result.applied += 1
  }
  return seen
}

/** 원격에서 받은 설정을 적용한다. 다시 변경 로그에 쌓이지 않도록 전용 경로가 있으면 그것을 쓴다 */
function applyFromSync(deps: PullDeps, patch: Partial<Settings>): void {
  if (deps.settings.setFromSync) deps.settings.setFromSync(patch)
  else deps.settings.set(patch)
}

function isSyncedSettingKey(key: string): key is (typeof SYNCED_SETTING_KEYS)[number] {
  return (SYNCED_SETTING_KEYS as readonly string[]).includes(key)
}

/** 지금 활성 작업공간의 원격 uuid. 주기마다 다시 읽는다(작업공간 전환 반영) */
function workspaceOf(deps: PullDeps): string {
  return deps.workspace().remoteId
}
