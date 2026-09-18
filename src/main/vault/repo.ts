// 금고 저장소 — drizzle 쿼리만 담당한다(암호화·상태 판단은 service.ts).
// sql.js 드라이버는 동기이므로 .all()/.get()/.run() 을 그대로 쓴다.

import { eq, and, isNull, desc } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sites, accounts, vaultItems, vaultMeta, auditLog } from '../db/schema'
import type { SiteDto, VaultItemMeta, VaultItemType } from '../../shared/vault'

// 암호문을 포함한 내부 행. 이 타입은 메인 프로세스 밖으로 나가지 않는다
export interface VaultItemRow {
  id: number
  accountId: number | null
  type: VaultItemType
  label: string
  ciphertext: Buffer
  iv: Buffer
  updatedAt: number
}

export interface AccountRow {
  id: number
  siteId: number
  host: string
  label: string
  username: string
  isDefault: boolean
}

export interface AuditRow {
  id: number
  at: number
  itemId: number | null
  action: string
  jobId: string | null
  source: string
}

export interface UpsertAccountInput {
  id?: number
  host: string
  label: string
  username: string
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
}

const AUDIT_LIST_LIMIT = 200

// sql.js 는 BLOB 을 Uint8Array 로 돌려준다. 항상 Buffer 로 맞춰 준다
function toBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

export class VaultRepo {
  constructor(private readonly db: Db) {}

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  // --- vault_meta -------------------------------------------------------

  getMeta(key: string): Buffer | null {
    const row = this.d.select().from(vaultMeta).where(eq(vaultMeta.key, key)).get()
    return row ? toBuffer(row.value) : null
  }

  setMeta(key: string, value: Buffer): void {
    this.d
      .insert(vaultMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: vaultMeta.key, set: { value } })
      .run()
    this.db.scheduleSave()
  }

  deleteMeta(key: string): void {
    this.d.delete(vaultMeta).where(eq(vaultMeta.key, key)).run()
    this.db.scheduleSave()
  }

  // --- sites ------------------------------------------------------------

  listSites(): SiteDto[] {
    return this.d
      .select()
      .from(sites)
      .all()
      .map((r) => ({
        id: r.id,
        host: r.host,
        name: r.name,
        ...(r.loginUrl ? { loginUrl: r.loginUrl } : {})
      }))
  }

  // host 를 키로 사이트를 만들거나 이름/로그인 URL 을 갱신한다
  upsertSite(host: string, name?: string, loginUrl?: string): number {
    const existing = this.d.select().from(sites).where(eq(sites.host, host)).get()
    if (existing) {
      const patch: { name?: string; loginUrl?: string } = {}
      if (name && name !== existing.name) patch.name = name
      if (loginUrl && loginUrl !== existing.loginUrl) patch.loginUrl = loginUrl
      if (Object.keys(patch).length > 0) {
        this.d.update(sites).set(patch).where(eq(sites.id, existing.id)).run()
        this.db.scheduleSave()
      }
      return existing.id
    }
    const inserted = this.d
      .insert(sites)
      .values({
        host,
        name: name ?? host,
        loginUrl: loginUrl ?? null,
        createdAt: Date.now()
      })
      .returning({ id: sites.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- accounts ---------------------------------------------------------

  listAccounts(host?: string): AccountRow[] {
    const base = this.d
      .select({
        id: accounts.id,
        siteId: accounts.siteId,
        host: sites.host,
        label: accounts.label,
        username: accounts.username,
        isDefault: accounts.isDefault
      })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
    const rows = host ? base.where(eq(sites.host, host)).all() : base.all()
    return rows
  }

  getAccount(id: number): AccountRow | null {
    const rows = this.d
      .select({
        id: accounts.id,
        siteId: accounts.siteId,
        host: sites.host,
        label: accounts.label,
        username: accounts.username,
        isDefault: accounts.isDefault
      })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(eq(accounts.id, id))
      .all()
    return rows[0] ?? null
  }

  upsertAccount(input: UpsertAccountInput): AccountRow {
    const now = Date.now()
    const siteId = this.upsertSite(input.host, input.siteName, input.loginUrl)
    const isDefault = input.isDefault ?? false

    // id 가 있으면 수정, 없으면 (siteId, username) 조합으로 기존 계정을 찾는다
    const existing = input.id
      ? (this.d.select().from(accounts).where(eq(accounts.id, input.id)).get() ?? null)
      : (this.d
          .select()
          .from(accounts)
          .where(and(eq(accounts.siteId, siteId), eq(accounts.username, input.username)))
          .get() ?? null)

    if (existing) {
      this.d
        .update(accounts)
        .set({
          siteId,
          label: input.label,
          username: input.username,
          isDefault,
          updatedAt: now
        })
        .where(eq(accounts.id, existing.id))
        .run()
      this.db.scheduleSave()
      const updated = this.getAccount(existing.id)
      if (!updated) throw new Error('계정을 찾을 수 없습니다')
      return updated
    }

    const inserted = this.d
      .insert(accounts)
      .values({
        siteId,
        label: input.label,
        username: input.username,
        isDefault,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: accounts.id })
      .all()
    this.db.scheduleSave()
    const created = this.getAccount(inserted[0].id)
    if (!created) throw new Error('계정을 만들지 못했습니다')
    return created
  }

  // 계정별 보유 항목 타입 목록(값 없음)
  itemTypesByAccount(): Map<number, VaultItemType[]> {
    const rows = this.d
      .select({ accountId: vaultItems.accountId, type: vaultItems.type })
      .from(vaultItems)
      .all()
    const map = new Map<number, VaultItemType[]>()
    for (const row of rows) {
      if (row.accountId === null) continue
      const list = map.get(row.accountId) ?? []
      const type = row.type as VaultItemType
      if (!list.includes(type)) list.push(type)
      map.set(row.accountId, list)
    }
    return map
  }

  // --- vault_items ------------------------------------------------------

  // 값(ciphertext/iv)을 제외한 메타만 돌려준다
  listItems(accountId: number | null): VaultItemMeta[] {
    const rows = this.d
      .select({
        id: vaultItems.id,
        accountId: vaultItems.accountId,
        type: vaultItems.type,
        label: vaultItems.label,
        updatedAt: vaultItems.updatedAt
      })
      .from(vaultItems)
      .where(
        accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId)
      )
      .all()
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      type: r.type as VaultItemType,
      label: r.label,
      updatedAt: r.updatedAt
    }))
  }

  getItemRow(id: number): VaultItemRow | null {
    const row = this.d.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      accountId: row.accountId,
      type: row.type as VaultItemType,
      label: row.label,
      ciphertext: toBuffer(row.ciphertext),
      iv: toBuffer(row.iv),
      updatedAt: row.updatedAt
    }
  }

  findItemRow(accountId: number | null, type: VaultItemType): VaultItemRow | null {
    const rows = this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId),
          eq(vaultItems.type, type)
        )
      )
      .all()
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      accountId: row.accountId,
      type: row.type as VaultItemType,
      label: row.label,
      ciphertext: toBuffer(row.ciphertext),
      iv: toBuffer(row.iv),
      updatedAt: row.updatedAt
    }
  }

  // AAD 로 쓸 id 를 먼저 얻기 위해 빈 암호문으로 행을 만든다(곧바로 updateItemSecret 로 채운다)
  insertItemPlaceholder(
    accountId: number | null,
    type: VaultItemType,
    label: string,
    updatedAt: number
  ): number {
    const inserted = this.d
      .insert(vaultItems)
      .values({
        accountId,
        type,
        label,
        ciphertext: Buffer.alloc(0),
        iv: Buffer.alloc(0),
        updatedAt
      })
      .returning({ id: vaultItems.id })
      .all()
    return inserted[0].id
  }

  updateItemSecret(
    id: number,
    ciphertext: Buffer,
    iv: Buffer,
    label: string,
    updatedAt: number
  ): void {
    this.d
      .update(vaultItems)
      .set({ ciphertext, iv, label, updatedAt })
      .where(eq(vaultItems.id, id))
      .run()
    this.db.scheduleSave()
  }

  deleteItem(id: number): void {
    this.d.delete(vaultItems).where(eq(vaultItems.id, id)).run()
    this.db.scheduleSave()
  }

  itemMeta(id: number): VaultItemMeta | null {
    const rows = this.d
      .select({
        id: vaultItems.id,
        accountId: vaultItems.accountId,
        type: vaultItems.type,
        label: vaultItems.label,
        updatedAt: vaultItems.updatedAt
      })
      .from(vaultItems)
      .where(eq(vaultItems.id, id))
      .all()
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id,
      accountId: r.accountId,
      type: r.type as VaultItemType,
      label: r.label,
      updatedAt: r.updatedAt
    }
  }

  // --- audit_log --------------------------------------------------------

  insertAudit(entry: {
    itemId: number | null
    action: string
    source: string
    jobId?: string
  }): void {
    this.d
      .insert(auditLog)
      .values({
        at: Date.now(),
        itemId: entry.itemId,
        action: entry.action,
        jobId: entry.jobId ?? null,
        source: entry.source
      })
      .run()
    this.db.scheduleSave()
  }

  listAudit(limit = AUDIT_LIST_LIMIT): AuditRow[] {
    return this.d.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all()
  }

  // 여러 쓰기를 한 트랜잭션으로 묶는다(항목 생성: placeholder insert → 암호문 update)
  transaction<T>(fn: () => T): T {
    return this.d.transaction(() => fn())
  }
}
