// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// C1 회귀 — 원격에서 지워진 행(tombstone)이 앱 화면에 남아 있으면 안 된다.
// 풀은 deleted_at 만 세우고 행은 남기므로, 앱 쪽 조회에 deleted_at IS NULL 필터가 필요하다

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase, type Db } from '../src/main/db/client'
import { accounts, bookmarks, vaultItems } from '../src/main/db/schema'
import { VaultService } from '../src/main/vault/service'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

const MASTER = 'master-pass-1234'

describe('tombstone 가 화면에 남지 않는다', () => {
  let db: Db
  let vault: VaultService

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, { get: () => DEFAULT_SETTINGS })
    await vault.setup(MASTER)
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  // 풀이 원격 삭제를 반영한 것과 같은 모양으로 tombstone 을 세운다
  function markAccountDeleted(id: number): void {
    db.drizzle.update(accounts).set({ deletedAt: Date.now() }).where(eq(accounts.id, id)).run()
  }

  it('삭제된 계정은 목록·피커·자동채움 후보에서 사라진다', () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me', label: '내 계정' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인 비밀번호', value: 'p@ss' })

    expect(vault.listAccounts('example.com')).toHaveLength(1)
    expect(vault.listPickerAccounts('example.com')).toHaveLength(1)
    expect(vault.getSecretForFill(account.id, 'login')).toBe('p@ss')

    markAccountDeleted(account.id)

    expect(vault.listAccounts('example.com')).toHaveLength(0)
    expect(vault.listPickerAccounts('example.com')).toHaveLength(0)
    // 항목 자체는 아직 살아 있지만 계정이 사라졌으므로 후보로 뜨지 않는다
    expect(vault.listAccounts()).toHaveLength(0)
  })

  it('삭제된 금고 항목은 목록·자동채움에서 사라진다', () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    const item = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: 'p@ss'
    })

    expect(vault.listItems(account.id)).toHaveLength(1)
    expect(vault.getSecretForFill(account.id, 'login')).toBe('p@ss')

    db.drizzle
      .update(vaultItems)
      .set({ deletedAt: Date.now() })
      .where(eq(vaultItems.id, item.id))
      .run()

    expect(vault.listItems(account.id)).toHaveLength(0)
    expect(vault.getSecretForFill(account.id, 'login')).toBeNull()
    // 계정 목록의 itemTypes 에서도 빠진다 — 피커는 login 항목이 있는 계정만 고른다
    expect(vault.listAccounts('example.com')[0].itemTypes).toEqual([])
    expect(vault.listPickerAccounts('example.com')).toHaveLength(0)
  })

  it('삭제된 북마크는 트리에서 사라진다', () => {
    const repo = new BookmarkRepo(db)
    const id = repo.createLink(null, '원격 북마크', 'https://remote.example')
    expect(repo.tree().links).toHaveLength(1)

    db.drizzle.update(bookmarks).set({ deletedAt: Date.now() }).where(eq(bookmarks.id, id)).run()

    expect(repo.tree().links).toHaveLength(0)
  })

  it('지워진 계정을 다시 저장하면 되살아난다', () => {
    // New-I4 — tombstone 행을 재활용하면서 deleted_at 을 비우지 않아, 저장은 성공했는데
    // 목록 어디에도 30일 동안 나타나지 않았다
    const account = vault.upsertAccount({ host: 'example.com', username: 'me', label: '내 계정' })
    markAccountDeleted(account.id)
    expect(vault.listAccounts('example.com')).toHaveLength(0)

    const again = vault.upsertAccount({ host: 'example.com', username: 'me' })

    expect(again.id).toBe(account.id)
    expect(vault.listAccounts('example.com')).toHaveLength(1)
    const row = db.drizzle.select().from(accounts).where(eq(accounts.id, account.id)).get()
    expect(row?.deletedAt).toBeNull()
  })

  it('계정 목록의 itemTypes 는 다른 작업공간의 항목을 세지 않는다', () => {
    // New-M3 — itemTypesByAccount 에 작업공간 조건이 빠져 있었다
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    const item = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: 'p@ss'
    })
    // 이 항목은 2번 작업공간의 것이다
    db.drizzle.update(vaultItems).set({ workspaceId: 2 }).where(eq(vaultItems.id, item.id)).run()

    vault.setWorkspaceScope({ id: 1, isDefault: true })
    expect(vault.listAccounts('example.com')[0].itemTypes).toEqual([])

    vault.setWorkspaceScope({ id: 2, isDefault: false })
    db.drizzle.update(accounts).set({ workspaceId: 2 }).where(eq(accounts.id, account.id)).run()
    expect(vault.listAccounts('example.com')[0].itemTypes).toEqual(['login'])
  })
})
