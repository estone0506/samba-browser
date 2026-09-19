// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 두 번째 PC 시나리오 — 같은 계정으로 로그인한 두 PC 가 **기본 작업공간**을 공유한다.
//
// 재리뷰 New-C1 회귀: 예전에는 작업공간 uuid 를 PC 마다 randomUUID 로 만들어,
// 풀 필터(.eq('workspace_id'))에 걸려 PC2 로는 아무것도 내려오지 않았다.
// 테스트가 양쪽에서 같은 WORKSPACE 상수를 쓰는 바람에 잡히지 않았으므로, 여기서는
// 각 PC 가 **자기 DB 의 sync_state 로부터 독립적으로** uuid 를 구하게 둔다

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { vaultMeta } from '../src/main/db/schema'
import { VaultService } from '../src/main/vault/service'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { pullAll } from '../src/main/sync/pull'
import { DEFAULT_WORKSPACE_REMOTE_ID, workspaceRemoteId } from '../src/main/sync/workspace-id'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const MASTER = 'master-pass-1234'
const SECRET = 'sup3rs3cret!'

function makeSettings(): SettingsAccess {
  let value: Settings = { ...DEFAULT_SETTINGS }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

/** 한 대의 PC — 자기 DB·자기 sync_state·자기 금고를 갖고, 백엔드만 공유한다 */
interface Pc {
  db: Db
  vault: VaultService
  bookmarks: BookmarkRepo
  outbox: SyncOutbox
  deps: PushDeps
}

/**
 * 마스터 키 재료(salt·KDF 파라미터·검증자)를 그대로 옮긴다.
 * 같은 마스터 비밀번호라도 salt 가 다르면 키가 달라 금고 암호문을 열 수 없다 —
 * 키 재료 동기화 자체는 2b 범위 밖이라, 여기서는 "같은 사용자의 같은 금고" 를 흉내낸다
 */
function copyVaultMeta(from: Db, to: Db): void {
  const rows = from.drizzle.select().from(vaultMeta).all()
  for (const row of rows) {
    to.drizzle
      .insert(vaultMeta)
      .values(row)
      .onConflictDoUpdate({ target: vaultMeta.key, set: { value: row.value } })
      .run()
  }
  to.scheduleSave()
}

describe('두 번째 PC 에서 기본 작업공간이 내려온다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  const makePc = async (db: Db): Promise<Pc> => {
    const outbox = new SyncOutbox(db)
    const settings = makeSettings()
    const vault = new VaultService(db, { get: settings.get })
    const bookmarks = new BookmarkRepo(db)
    // 각 PC 는 자기 DB 에서 기본 작업공간(로컬 id 1)의 원격 uuid 를 스스로 구한다
    const workspace = (): { localId: number; remoteId: string } => ({
      localId: 1,
      remoteId: workspaceRemoteId(db, 1, true)
    })
    const recorder = createOutboxRecorder(db, outbox, () => 1)
    vault.setOutboxRecorder(recorder)
    bookmarks.setOutboxRecorder(recorder)
    return {
      db,
      vault,
      bookmarks,
      outbox,
      deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace }
    }
  }

  beforeEach(async () => {
    backend = createFakeBackend()
    const db1 = await openDatabase(':memory:')
    const db2 = await openDatabase(':memory:')
    pc1 = await makePc(db1)
    pc2 = await makePc(db2)
    await pc1.vault.setup(MASTER)
    copyVaultMeta(db1, db2)
    await pc2.vault.unlock(MASTER)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  it('두 PC 가 기본 작업공간에 같은 고정 uuid 를 쓴다', () => {
    expect(pc1.deps.workspace().remoteId).toBe(DEFAULT_WORKSPACE_REMOTE_ID)
    expect(pc2.deps.workspace().remoteId).toBe(DEFAULT_WORKSPACE_REMOTE_ID)
  })

  it('PC1 이 올린 계정·북마크·금고 항목이 PC2 로 내려온다', async () => {
    const account = pc1.vault.upsertAccount({
      host: 'example.com',
      username: 'me',
      label: '내 계정'
    })
    pc1.vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    pc1.bookmarks.createLink(null, '원격 북마크', 'https://remote.example')

    const pushed = await pushAll(pc1.deps)
    expect(pushed.failed).toBe(0)
    expect(pushed.sent).toBe(3)
    // 올라간 행은 모두 고정 uuid 를 달고 있다
    for (const table of ['accounts_sync', 'vault_items_sync', 'bookmarks_sync']) {
      expect(backend.rows(table)).toHaveLength(1)
      expect(backend.rows(table)[0].workspace_id).toBe(DEFAULT_WORKSPACE_REMOTE_ID)
    }

    const pulled = await pullAll(pc2.deps)
    expect(pulled.applied).toBe(3)

    // 계정이 PC2 의 화면에 보인다
    pc2.vault.setWorkspaceScope({ id: 1, isDefault: true })
    const accounts = pc2.vault.listAccounts('example.com')
    expect(accounts).toHaveLength(1)
    expect(accounts[0].label).toBe('내 계정')

    // 금고 항목은 암호문으로 왕복하고, PC2 의 마스터 키로 값까지 열린다
    const items = pc2.vault.listItems(accounts[0].id)
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('로그인')
    expect(pc2.vault.reveal(items[0].id)).toBe(SECRET)

    // 북마크도 보인다
    pc2.bookmarks.setWorkspaceScope({ id: 1, isDefault: true })
    const links = pc2.bookmarks.tree().links.map((l) => l.url)
    expect(links).toEqual(['https://remote.example'])
  })

  it('PC2 의 변경이 다시 PC1 로 돌아온다(양방향)', async () => {
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)

    pc2.bookmarks.createLink(null, 'PC2 북마크', 'https://from-pc2.example')
    const pushed = await pushAll(pc2.deps)
    expect(pushed.sent).toBe(1)

    await pullAll(pc1.deps)

    pc1.bookmarks.setWorkspaceScope({ id: 1, isDefault: true })
    expect(pc1.bookmarks.tree().links.map((l) => l.url)).toContain('https://from-pc2.example')
  })
})
