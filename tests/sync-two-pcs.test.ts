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
import { VaultService } from '../src/main/vault/service'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { backfillOutbox, verifyBackfill } from '../src/main/sync/backfill'
import {
  accounts as accountsTable,
  bookmarks as bookmarksTable,
  vaultItems as vaultItemsTable
} from '../src/main/db/schema'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { pullAll } from '../src/main/sync/pull'
import { DEFAULT_WORKSPACE_REMOTE_ID, workspaceRemoteId } from '../src/main/sync/workspace-id'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { VAULT_KEY_SYNC_KEYS } from '../src/shared/sync'

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
  /** 변경 로그 훅을 붙인다(= 로그인). 붙이기 전의 변경은 기록되지 않는다 */
  signIn: () => void
}

function makePc(db: Db, backend: FakeBackend, signedIn = true): Pc {
  const outbox = new SyncOutbox(db)
  const settings = makeSettings()
  const vault = new VaultService(db, { get: settings.get })
  const bookmarks = new BookmarkRepo(db)
  // 각 PC 는 자기 DB 에서 기본 작업공간(로컬 id 1)의 원격 uuid 를 스스로 구한다
  const workspace = (): { localId: number; remoteId: string } => ({
    localId: 1,
    remoteId: workspaceRemoteId(db, 1, true)
  })
  const pc: Pc = {
    db,
    vault,
    bookmarks,
    outbox,
    deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace },
    // 실제 SyncConnection.attachRecorders 와 같은 훅을 붙인다
    signIn: () => {
      const recorder = createOutboxRecorder(db, outbox, () => 1)
      vault.setOutboxRecorder(recorder)
      bookmarks.setOutboxRecorder(recorder)
    }
  }
  if (signedIn) pc.signIn()
  return pc
}

describe('두 번째 PC 에서 기본 작업공간이 내려온다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    const db1 = await openDatabase(':memory:')
    const db2 = await openDatabase(':memory:')
    pc1 = makePc(db1, backend)
    pc2 = makePc(db2, backend)
    await pc1.vault.setup(MASTER)
    // 마스터 키 재료(salt·KDF·검증자)가 동기화로 건너가야 PC2 가 같은 키를 유도할 수 있다
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)
    const opened = await pc2.vault.unlock(MASTER)
    expect(opened).toBe(true)
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

  it('키 재료가 동기화돼 PC2 가 같은 마스터 비밀번호로 연다', async () => {
    // 서버에는 키 재료 세 키가 올라가 있다(값은 base64·JSON 문자열이고 비밀이 아니다)
    const keys = backend.keyedRows('settings_sync').map((r) => String(r.key))
    expect(keys).toEqual(expect.arrayContaining(['vault.salt', 'vault.kdf', 'vault.verifier']))

    // PC2 는 자기 DB 에 마스터를 설정한 적이 없는데도 '잠김' 을 거쳐 열렸다
    expect(pc2.vault.state()).toBe('unlocked')
    pc2.vault.lock()
    expect(pc2.vault.state()).toBe('locked')
    expect(await pc2.vault.unlock('다른-비밀번호')).toBe(false)
    expect(await pc2.vault.unlock(MASTER)).toBe(true)

    // 그 키로 PC1 이 올린 값이 실제로 열린다
    const account = pc1.vault.upsertAccount({ host: 'example.com', username: 'me' })
    pc1.vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)

    pc2.vault.setWorkspaceScope({ id: 1, isDefault: true })
    const accounts = pc2.vault.listAccounts('example.com')
    const items = pc2.vault.listItems(accounts[0].id)
    expect(pc2.vault.reveal(items[0].id)).toBe(SECRET)
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

describe('마스터 키 재료 동기화의 경계', () => {
  let backend: FakeBackend
  let db1: Db
  let db2: Db
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    db1 = await openDatabase(':memory:')
    db2 = await openDatabase(':memory:')
    pc1 = makePc(db1, backend)
    pc2 = makePc(db2, backend)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    db1.close()
    db2.close()
  })

  it('키 재료를 받은 PC2 는 "원격에서 설정됨" 표식을 달고 잠긴 상태가 된다', async () => {
    expect(pc2.vault.state()).toBe('uninitialized')

    await pc1.vault.setup(MASTER)
    await pushAll(pc1.deps)
    const pulled = await pullAll(pc2.deps)

    expect(pulled.vaultKeyMismatch).toBe(false)
    expect(pc2.vault.state()).toBe('locked')
    expect(pc2.vault.isKeyFromSync()).toBe(true)
    // 키 재료를 올린 PC1 은 자기 값과 같으므로 표식이 붙지 않는다
    expect(pc1.vault.isKeyFromSync()).toBe(false)

    // 한 번 열고 나면 안내 표식은 사라진다
    expect(await pc2.vault.unlock(MASTER)).toBe(true)
    expect(pc2.vault.isKeyFromSync()).toBe(false)
  })

  it('이미 다른 마스터로 설정된 PC 는 덮어쓰지 않고 불일치를 알린다', async () => {
    await pc1.vault.setup(MASTER)
    await pushAll(pc1.deps)
    // PC2 는 이 PC 에서 따로 금고를 만들어 뒀다(salt 가 다르다)
    await pc2.vault.setup('another-master-9999')

    const pulled = await pullAll(pc2.deps)

    expect(pulled.vaultKeyMismatch).toBe(true)
    // 로컬 키 재료는 그대로다 — 이 PC 의 마스터로 계속 열린다
    expect(pc2.vault.readKeyMaterial('vault.salt')).not.toBe(
      pc1.vault.readKeyMaterial('vault.salt')
    )
    pc2.vault.lock()
    expect(await pc2.vault.unlock(MASTER)).toBe(false)
    expect(await pc2.vault.unlock('another-master-9999')).toBe(true)
  })
})

describe('첫 로그인 시 로컬 기존 데이터가 전부 올라간다', () => {
  let backend: FakeBackend
  let db1: Db
  let db2: Db
  let pc1: Pc
  let pc2: Pc

  // 로그인 전(훅 없음) 상태에서 PC1 에 데이터를 쌓아 둔다 — 실검수에서 문제가 된 상황 그대로
  beforeEach(async () => {
    backend = createFakeBackend()
    db1 = await openDatabase(':memory:')
    db2 = await openDatabase(':memory:')
    pc1 = makePc(db1, backend, false)
    pc2 = makePc(db2, backend)
    await pc1.vault.setup(MASTER)
    const account = pc1.vault.upsertAccount({
      host: 'old.example',
      username: 'before-login',
      label: '로그인 전 계정'
    })
    pc1.vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    pc1.bookmarks.createLink(null, '로그인 전 북마크', 'https://old.example/page')
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    db1.close()
    db2.close()
  })

  it('훅이 없던 동안의 변경은 변경 로그에 한 줄도 없다(문제 재현)', () => {
    expect(pc1.outbox.count()).toBe(0)
  })

  it('로그인하면 기존 계정·금고·북마크·키 재료가 올라가고 PC2 로 내려온다', async () => {
    pc1.signIn()
    const result = backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)

    expect(result.skipped).toBe(false)
    expect(result.accounts).toBe(1)
    expect(result.vaultItems).toBe(1)
    expect(result.bookmarks).toBe(1)
    // 동기화 대상 설정 + 금고 키 재료 세 키가 함께 올라간다
    expect(result.settings).toBeGreaterThanOrEqual(VAULT_KEY_SYNC_KEYS.length)

    const pushed = await pushAll(pc1.deps)
    expect(pushed.failed).toBe(0)
    expect(backend.rows('accounts_sync')).toHaveLength(1)
    expect(backend.rows('vault_items_sync')).toHaveLength(1)
    expect(backend.rows('bookmarks_sync')).toHaveLength(1)

    // PC2 는 같은 마스터 비밀번호로 열고, 내려온 데이터를 그대로 본다
    await pullAll(pc2.deps)
    expect(await pc2.vault.unlock(MASTER)).toBe(true)
    await pullAll(pc2.deps)

    pc2.vault.setWorkspaceScope({ id: 1, isDefault: true })
    const accounts = pc2.vault.listAccounts('old.example')
    expect(accounts).toHaveLength(1)
    expect(accounts[0].label).toBe('로그인 전 계정')
    const items = pc2.vault.listItems(accounts[0].id)
    expect(pc2.vault.reveal(items[0].id)).toBe(SECRET)

    pc2.bookmarks.setWorkspaceScope({ id: 1, isDefault: true })
    expect(pc2.bookmarks.tree().links.map((l) => l.url)).toEqual(['https://old.example/page'])
  })

  it('커서가 이미 앞서 있는 PC2 에도 로그인 전 데이터가 도달한다', async () => {
    // 실검수 회귀: 어제 가져온 계정·북마크가 **가져오기 시각 그대로** 올라가는 바람에,
    // 커서가 오늘까지 전진해 있던 PC2 의 풀(updated_at > cursor)에 영영 걸리지 않았다
    const yesterday = Date.now() - 24 * 60 * 60 * 1000
    db1.drizzle.update(accountsTable).set({ updatedAt: yesterday }).run()
    db1.drizzle.update(vaultItemsTable).set({ updatedAt: yesterday }).run()
    db1.drizzle.update(bookmarksTable).set({ updatedAt: yesterday }).run()

    // PC2 가 자기 변경을 먼저 주고받아, 커서가 오늘까지 전진한다
    pc2.bookmarks.createLink(null, 'PC2 북마크', 'https://pc2.example')
    await pushAll(pc2.deps)
    await pullAll(pc2.deps)

    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    const pushed = await pushAll(pc1.deps)
    expect(pushed.failed).toBe(0)

    await pullAll(pc2.deps)
    expect(await pc2.vault.unlock(MASTER)).toBe(true)
    await pullAll(pc2.deps)

    pc2.vault.setWorkspaceScope({ id: 1, isDefault: true })
    const accounts = pc2.vault.listAccounts('old.example')
    expect(accounts).toHaveLength(1)
    expect(pc2.vault.reveal(pc2.vault.listItems(accounts[0].id)[0].id)).toBe(SECRET)

    pc2.bookmarks.setWorkspaceScope({ id: 1, isDefault: true })
    expect(pc2.bookmarks.tree().links.map((l) => l.url)).toContain('https://old.example/page')
  })

  it('두 번 불러도 같은 행을 두 번 넣지 않는다', () => {
    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    const afterFirst = pc1.outbox.count()

    const second = backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    expect(second.skipped).toBe(true)
    expect(pc1.outbox.count()).toBe(afterFirst)

    // 플래그를 무시하는 재검사도 이미 대기 중인 행은 건너뛴다
    const verified = verifyBackfill(db1, pc1.deps.workspace(), pc1.vault)
    expect(verified.accounts + verified.vaultItems + verified.bookmarks).toBe(0)
    expect(pc1.outbox.count()).toBe(afterFirst)
  })

  it('전송이 끝난 뒤의 재검사는 같은 행을 다시 올리지 않는다', async () => {
    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    await pushAll(pc1.deps)
    expect(pc1.outbox.count()).toBe(0)

    const verified = verifyBackfill(db1, pc1.deps.workspace(), pc1.vault)
    expect(verified.accounts + verified.vaultItems + verified.bookmarks + verified.settings).toBe(0)
    expect(pc1.outbox.count()).toBe(0)
  })

  it('재검사가 변경 로그를 놓친 행을 보충한다', async () => {
    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    await pushAll(pc1.deps)

    // 훅이 없던 시점의 가져오기처럼, 변경 로그 없이 북마크가 하나 더 생긴 상황
    pc1.bookmarks.setOutboxRecorder(null)
    pc1.bookmarks.createLink(null, '놓친 북마크', 'https://missed.example')
    pc1.signIn()
    expect(pc1.outbox.count()).toBe(0)

    const verified = verifyBackfill(db1, pc1.deps.workspace(), pc1.vault)
    expect(verified.bookmarks).toBe(1)
    await pushAll(pc1.deps)
    expect(backend.rows('bookmarks_sync')).toHaveLength(2)
  })

  it('금고가 잠겨 있으면 금고 항목만 보류했다가 해제 뒤에 올린다', async () => {
    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    pc1.vault.lock()

    const locked = await pushAll(pc1.deps)
    expect(locked.skipped).toBe(1)
    expect(backend.rows('accounts_sync')).toHaveLength(1)
    expect(backend.rows('bookmarks_sync')).toHaveLength(1)
    // 금고 항목은 서버에 없지만 변경 로그에는 그대로 남아 있다
    expect(backend.rows('vault_items_sync')).toHaveLength(0)
    expect(pc1.outbox.pendingFor('vault_items')).toHaveLength(1)

    expect(await pc1.vault.unlock(MASTER)).toBe(true)
    const unlocked = await pushAll(pc1.deps)
    expect(unlocked.sent).toBe(1)
    expect(backend.rows('vault_items_sync')).toHaveLength(1)
    expect(pc1.outbox.pendingFor('vault_items')).toHaveLength(0)
  })

  it('작업공간을 새로 붙이면 그 작업공간에 대해서도 한 번 더 돈다', () => {
    pc1.signIn()
    backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)

    // 두 번째 작업공간의 북마크는 기본 작업공간 범위에 들지 않아 아직 대기열에 없다
    db1.drizzle
      .insert(bookmarksTable)
      .values({
        folderId: null,
        title: '작업공간2',
        url: 'https://ws2.example',
        position: 0,
        workspaceId: 2
      })
      .run()
    expect(verifyBackfill(db1, pc1.deps.workspace(), pc1.vault).bookmarks).toBe(0)

    const second = backfillOutbox(db1, { localId: 2, remoteId: 'ws-2-uuid' }, pc1.vault)
    expect(second.skipped).toBe(false)
    expect(second.bookmarks).toBe(1)
  })

  it('수천 행도 몇 초 안에 대기열에 오른다', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      folderId: null,
      title: `대량 ${i}`,
      url: `https://bulk.example/${i}`,
      position: i,
      workspaceId: null
    }))
    db1.drizzle.insert(bookmarksTable).values(rows).run()

    pc1.signIn()
    const started = Date.now()
    const result = backfillOutbox(db1, pc1.deps.workspace(), pc1.vault)
    const elapsed = Date.now() - started

    expect(result.bookmarks).toBe(2001)
    expect(elapsed).toBeLessThan(5000)
  })
})
