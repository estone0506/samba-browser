// 동기화가 만지는 로컬 행 읽기·쓰기 모음.
// push.ts / pull.ts 가 같은 질의를 두 벌 들고 있지 않도록 여기 한 곳에 모았다.
// 기존 저장소(VaultRepo·BookmarkRepo)는 "앱 기능" 관점의 질의만 담당하고,
// 여기에는 remote_id·deleted_at 처럼 동기화에만 쓰는 컬럼 질의를 둔다

import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  accounts,
  bookmarkFolders,
  bookmarks,
  chatMessages,
  chats,
  sites,
  syncState,
  vaultItems
} from '../db/schema'
import type { SyncTable } from '../../shared/sync'
import { isChatRole } from '../../shared/chat'
import { parseSteps } from '../chat/repo'
import { TOMBSTONE_TTL_MS } from './merge'
import type {
  AccountSyncRow,
  BookmarkSyncRow,
  ChatMessageSyncRow,
  ChatSyncRow,
  VaultItemSyncRow
} from './mappers'

/** 폴더 경로 구분자. bookmarks_sync.folder_path 도 같은 규칙을 쓴다 */
const PATH_SEPARATOR = '/'

export class SyncLocal {
  /**
   * 풀로 내려받은 행에 채울 활성 작업공간의 로컬 id.
   * null 이면(동기화 밖 호출) 작업공간 컬럼을 건드리지 않는다 — 이 값이 없으면 내려받은
   * 행이 전부 NULL 로 남아 비기본 작업공간에서는 보이지 않는다
   */
  constructor(
    private readonly db: Db,
    private readonly workspaceLocalId: number | null = null
  ) {}

  /** 내려받은 행에 붙일 작업공간 컬럼. 모르면 아예 넣지 않는다 */
  private get workspacePatch(): { workspaceId: number } | Record<string, never> {
    return this.workspaceLocalId === null ? {} : { workspaceId: this.workspaceLocalId }
  }

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  // --- sync_state -----------------------------------------------------------

  getState(key: string): string | null {
    const row = this.d.select().from(syncState).where(eq(syncState.key, key)).get()
    return row ? row.value : null
  }

  getStateNumber(key: string): number | null {
    const raw = this.getState(key)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  setState(key: string, value: string): void {
    this.d
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run()
    this.db.scheduleSave()
  }

  setStateNumber(key: string, value: number): void {
    this.setState(key, String(value))
  }

  // --- 계정 -----------------------------------------------------------------

  accountForSync(id: number): AccountSyncRow | null {
    const rows = this.d
      .select({ account: accounts, host: sites.host })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(eq(accounts.id, id))
      .all()
    const row = rows[0]
    if (!row) return null
    return {
      id: row.account.id,
      remoteId: row.account.remoteId,
      host: row.host,
      label: row.account.label,
      username: row.account.username,
      isDefault: row.account.isDefault,
      urls: parseStringArray(row.account.urls),
      agentAccess: row.account.agentAccess,
      tags: parseStringArray(row.account.tags),
      pausedUntil: row.account.pausedUntil,
      updatedAt: row.account.updatedAt,
      deletedAt: row.account.deletedAt
    }
  }

  accountIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  accountIdByHostUsername(host: string, username: string): number | null {
    const rows = this.d
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(and(eq(sites.host, host), eq(accounts.username, username)))
      .all()
    return rows[0]?.id ?? null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setAccountRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(accounts)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(accounts.id, id))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 원격 id 가 아직 없는 계정에 하나 만들어 붙인다.
   * 금고 항목이 account_id 로 가리켜야 하는데 계정이 아직 올라가지 않은 경우에 쓴다.
   * 이 계정도 서버에 한 번도 없던 행이므로 수정 시각을 지금으로 올린다 —
   * 옛 시각 그대로 올라가면 커서가 앞서 있는 다른 PC 의 풀에 걸리지 않는다
   */
  ensureAccountRemoteId(id: number, generate: () => string): string | null {
    const row = this.d
      .select({ remoteId: accounts.remoteId, updatedAt: accounts.updatedAt })
      .from(accounts)
      .where(eq(accounts.id, id))
      .get()
    if (!row) return null
    if (row.remoteId) return row.remoteId
    const remoteId = generate()
    this.setAccountRemoteId(id, remoteId, Math.max(row.updatedAt ?? 0, Date.now()))
    return remoteId
  }

  /** 원격 계정 행을 로컬에 반영한다(없으면 만든다). 돌려주는 값은 로컬 id */
  applyAccount(row: Omit<AccountSyncRow, 'id'>, localId: number | null): number {
    const siteId = this.upsertSite(row.host)
    const patch = {
      siteId,
      label: row.label,
      username: row.username,
      isDefault: row.isDefault,
      urls: JSON.stringify(row.urls),
      agentAccess: row.agentAccess,
      tags: JSON.stringify(row.tags),
      pausedUntil: row.pausedUntil,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(accounts).set(patch).where(eq(accounts.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(accounts)
      .values({ ...patch, createdAt: row.updatedAt })
      .returning({ id: accounts.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  private upsertSite(host: string): number {
    const existing = this.d.select({ id: sites.id }).from(sites).where(eq(sites.host, host)).get()
    if (existing) return existing.id
    const inserted = this.d
      .insert(sites)
      .values({ host, name: host, loginUrl: null, createdAt: Date.now() })
      .returning({ id: sites.id })
      .all()
    return inserted[0].id
  }

  // --- 금고 항목 -------------------------------------------------------------

  vaultItemForSync(id: number): VaultItemSyncRow | null {
    const row = this.d.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      accountId: row.accountId,
      accountRemoteId: row.accountId === null ? null : this.accountRemoteIdOf(row.accountId),
      type: row.type,
      label: row.label,
      fieldsJson: row.fields ?? '[]',
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  accountRemoteIdOf(accountId: number): string | null {
    const row = this.d
      .select({ remoteId: accounts.remoteId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get()
    return row?.remoteId ?? null
  }

  vaultItemIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(eq(vaultItems.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  vaultItemUpdatedAt(id: number): number | null {
    const row = this.d
      .select({ updatedAt: vaultItems.updatedAt, deletedAt: vaultItems.deletedAt })
      .from(vaultItems)
      .where(eq(vaultItems.id, id))
      .get()
    return row ? row.updatedAt : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setVaultItemRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(vaultItems)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(vaultItems.id, id))
      .run()
    this.db.scheduleSave()
  }

  /** 원격 금고 행을 로컬에 반영한다(없으면 만든다). fieldsJson 은 이미 복호화된 값이다 */
  applyVaultItem(
    row: Omit<VaultItemSyncRow, 'id' | 'accountId'> & { remoteId: string },
    localId: number | null
  ): number {
    const accountId =
      row.accountRemoteId === null ? null : this.accountIdByRemote(row.accountRemoteId)
    const patch = {
      accountId,
      type: row.type,
      label: row.label,
      fields: row.fieldsJson,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(vaultItems).set(patch).where(eq(vaultItems.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    // ciphertext/iv 는 v1 스키마의 NOT NULL 잔재라 빈 버퍼를 넣는다(값은 fields 안에 있다)
    const inserted = this.d
      .insert(vaultItems)
      .values({ ...patch, ciphertext: Buffer.alloc(0), iv: Buffer.alloc(0) })
      .returning({ id: vaultItems.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- 북마크 ---------------------------------------------------------------

  /** 폴더 트리를 따라 올라가며 경로를 만든다(예: '북마크바/개발'). 루트면 빈 문자열 */
  folderPath(folderId: number | null): string {
    if (folderId === null) return ''
    const rows = this.d
      .select({
        id: bookmarkFolders.id,
        parentId: bookmarkFolders.parentId,
        name: bookmarkFolders.name
      })
      .from(bookmarkFolders)
      .all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const names: string[] = []
    const visited = new Set<number>()
    let cursor: number | null = folderId
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor)
      const node = byId.get(cursor)
      if (!node) break
      names.unshift(node.name)
      cursor = node.parentId
    }
    return names.join(PATH_SEPARATOR)
  }

  /** 경로를 따라 폴더를 찾고, 없는 단계는 만든다. 빈 경로는 루트(null) */
  ensureFolderPath(path: string): number | null {
    const names = path.split(PATH_SEPARATOR).filter((s) => s.trim().length > 0)
    let parentId: number | null = null
    for (const name of names) {
      const siblings = this.d
        .select({ id: bookmarkFolders.id, name: bookmarkFolders.name })
        .from(bookmarkFolders)
        .where(
          parentId === null
            ? isNull(bookmarkFolders.parentId)
            : eq(bookmarkFolders.parentId, parentId)
        )
        .all()
      const found = siblings.find((f) => f.name === name)
      if (found) {
        parentId = found.id
        continue
      }
      const inserted = this.d
        .insert(bookmarkFolders)
        .values({ parentId, name, position: siblings.length, isToolbar: 0, addDate: null })
        .returning({ id: bookmarkFolders.id })
        .all()
      parentId = inserted[0].id
    }
    this.db.scheduleSave()
    return parentId
  }

  bookmarkForSync(id: number): BookmarkSyncRow | null {
    const row = this.d.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      folderPath: this.folderPath(row.folderId),
      title: row.title,
      url: row.url,
      position: row.position,
      // updated_at 은 2b 에서 추가된 컬럼이라 옛 행은 비어 있다. 가져온 시각·0 순으로 메운다
      updatedAt: row.updatedAt ?? row.addedAt ?? 0,
      deletedAt: row.deletedAt
    }
  }

  listBookmarksForSync(): BookmarkSyncRow[] {
    return this.d
      .select()
      .from(bookmarks)
      .all()
      .map((row) => ({
        id: row.id,
        remoteId: row.remoteId,
        folderPath: this.folderPath(row.folderId),
        title: row.title,
        url: row.url,
        position: row.position,
        updatedAt: row.updatedAt ?? row.addedAt ?? 0,
        deletedAt: row.deletedAt
      }))
  }

  bookmarkIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(eq(bookmarks.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setBookmarkRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(bookmarks)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(bookmarks.id, id))
      .run()
    this.db.scheduleSave()
  }

  applyBookmark(row: Omit<BookmarkSyncRow, 'id'>, localId: number | null): number {
    const folderId = this.ensureFolderPath(row.folderPath)
    const patch = {
      folderId,
      title: row.title,
      url: row.url,
      position: row.position,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(bookmarks).set(patch).where(eq(bookmarks.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d.insert(bookmarks).values(patch).returning({ id: bookmarks.id }).all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- AI 채팅 ---------------------------------------------------------------

  chatForSync(id: number): ChatSyncRow | null {
    const row = this.d.select().from(chats).where(eq(chats.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  chatIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  setChatRemoteId(id: number, remoteId: string): void {
    this.d.update(chats).set({ remoteId }).where(eq(chats.id, id)).run()
    this.db.scheduleSave()
  }

  /** 메시지의 chat_id 가 가리킬 대상이 아직 없으면 원격 id 만 먼저 만들어 붙인다 */
  ensureChatRemoteId(id: number, generate: () => string): string | null {
    const row = this.d
      .select({ remoteId: chats.remoteId })
      .from(chats)
      .where(eq(chats.id, id))
      .get()
    if (!row) return null
    if (row.remoteId) return row.remoteId
    const remoteId = generate()
    this.setChatRemoteId(id, remoteId)
    return remoteId
  }

  applyChat(row: Omit<ChatSyncRow, 'id'> & { remoteId: string }, localId: number | null): number {
    const patch = {
      title: row.title,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(chats).set(patch).where(eq(chats.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(chats)
      .values({ ...patch, createdAt: row.createdAt })
      .returning({ id: chats.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  chatMessageForSync(id: number): ChatMessageSyncRow | null {
    const row = this.d.select().from(chatMessages).where(eq(chatMessages.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      chatId: row.chatId,
      chatRemoteId: this.chatRemoteIdOf(row.chatId),
      role: isChatRole(row.role) ? row.role : 'system',
      content: row.content,
      steps: parseSteps(row.steps),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  chatRemoteIdOf(chatId: number): string | null {
    const row = this.d
      .select({ remoteId: chats.remoteId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()
    return row?.remoteId ?? null
  }

  chatMessageIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  setChatMessageRemoteId(id: number, remoteId: string): void {
    this.d.update(chatMessages).set({ remoteId }).where(eq(chatMessages.id, id)).run()
    this.db.scheduleSave()
  }

  /**
   * 원격 메시지를 로컬에 반영한다. 대화(chat_id)를 로컬에서 못 찾으면 null 을 돌려준다 —
   * 호출부는 그 행을 건너뛰고 커서도 올리지 않는다(다음 주기에 대화가 먼저 내려온 뒤 다시 본다)
   */
  applyChatMessage(
    row: Omit<ChatMessageSyncRow, 'id' | 'chatId'> & { remoteId: string },
    localId: number | null
  ): number | null {
    const chatId = row.chatRemoteId === null ? null : this.chatIdByRemote(row.chatRemoteId)
    if (chatId === null) return null
    const patch = {
      chatId,
      role: row.role,
      content: row.content,
      steps: row.steps === null ? null : JSON.stringify(row.steps),
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt
    }
    if (localId !== null) {
      this.d.update(chatMessages).set(patch).where(eq(chatMessages.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(chatMessages)
      .values({ ...patch, createdAt: row.createdAt })
      .returning({ id: chatMessages.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- 삭제 스냅샷 -----------------------------------------------------------

  /**
   * 행을 지우기 직전에 떠 두는 스냅샷. 원격 삭제 표식(tombstone)을 만들려면
   * host·label·url 같은 NOT NULL 컬럼이 필요한데, 지운 뒤에는 읽을 수 없다
   */
  snapshotForDelete(
    table: SyncTable,
    rowId: number
  ): AccountSyncRow | VaultItemSyncRow | BookmarkSyncRow | ChatSyncRow | ChatMessageSyncRow | null {
    if (table === 'accounts') return this.accountForSync(rowId)
    if (table === 'vault_items') return this.vaultItemForSync(rowId)
    if (table === 'bookmarks') return this.bookmarkForSync(rowId)
    if (table === 'chats') return this.chatForSync(rowId)
    if (table === 'chat_messages') return this.chatMessageForSync(rowId)
    return null
  }

  // --- tombstone 정리 --------------------------------------------------------

  /** 30일이 지난 삭제 표식을 물리 삭제한다. 돌려주는 값은 지운 행 수 */
  pruneExpiredTombstones(now: number): number {
    const cutoff = now - TOMBSTONE_TTL_MS
    let pruned = 0
    // 메시지를 먼저 지운다 — 대화가 먼저 사라지면 외래 키가 가리킬 대상이 없어진다
    for (const table of [accounts, vaultItems, bookmarks, chatMessages, chats]) {
      const rows = this.d
        .select({ id: table.id })
        .from(table)
        .where(and(isNotNull(table.deletedAt), lt(table.deletedAt, cutoff)))
        .all()
      for (const row of rows) {
        this.d.delete(table).where(eq(table.id, row.id)).run()
        pruned += 1
      }
    }
    if (pruned > 0) this.db.scheduleSave()
    return pruned
  }
}

// JSON 으로 저장된 string[] 컬럼(urls/tags)을 읽는다. 깨져 있으면 빈 배열
function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}
