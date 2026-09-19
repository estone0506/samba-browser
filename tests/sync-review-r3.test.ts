// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 2b 3차 리뷰(C1·C2·I1·I2·M7) 회귀 테스트.
// 모두 두 PC 가 가짜 백엔드 하나를 공유하는 구조다(네트워크 없음)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { ChatRepo } from '../src/main/chat/repo'
import { SyncOutbox, createOutboxRecorder, settingUpdatedAtKey } from '../src/main/sync/outbox'
import { backfillOutbox, backfillSettings, verifyBackfill } from '../src/main/sync/backfill'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { pullAll, pullCursorKey } from '../src/main/sync/pull'
import { SyncLocal } from '../src/main/sync/local'
import { workspaceRemoteId } from '../src/main/sync/workspace-id'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { vaultItems as vaultItemsTable } from '../src/main/db/schema'

const MASTER = 'master-pass-1234'
const SECRET = 'sup3rs3cret!'

interface Pc {
  db: Db
  vault: VaultService
  bookmarks: BookmarkRepo
  chats: ChatRepo
  outbox: SyncOutbox
  settings: SettingsAccess
  deps: PushDeps
  signIn: () => void
}

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

function makePc(db: Db, backend: FakeBackend, signedIn = true): Pc {
  const outbox = new SyncOutbox(db)
  const settings = makeSettings()
  const vault = new VaultService(db, { get: settings.get })
  const bookmarks = new BookmarkRepo(db)
  const chats = new ChatRepo(db)
  chats.setWorkspaceScope({ id: 1, isDefault: true })
  vault.setWorkspaceScope({ id: 1, isDefault: true })
  const workspace = (): { localId: number; remoteId: string } => ({
    localId: 1,
    remoteId: workspaceRemoteId(db, 1, true)
  })
  const pc: Pc = {
    db,
    vault,
    bookmarks,
    chats,
    outbox,
    settings,
    deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace },
    signIn: () => {
      const recorder = createOutboxRecorder(db, outbox, () => 1)
      vault.setOutboxRecorder(recorder)
      settings.setOutboxRecorder?.(recorder)
      bookmarks.setOutboxRecorder(recorder)
      chats.setOutboxRecorder(recorder)
    }
  }
  if (signedIn) pc.signIn()
  return pc
}

/** 엔진 한 주기와 같은 순서 — 풀 → 설정 최초 업로드 → 푸시 */
async function cycle(pc: Pc): Promise<void> {
  await pullAll(pc.deps)
  backfillSettings(pc.db, pc.deps.workspace(), pc.vault)
  await pushAll(pc.deps)
}

// ---------------------------------------------------------------------------
// C1 — 설정은 최초 업로드에서 빠지고, 풀을 한 번 돌린 뒤 서버에 없던 키만 올린다
// ---------------------------------------------------------------------------
describe('C1 — 두 번째 PC 의 첫 로그인이 첫 PC 의 설정을 덮지 않는다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend)
    pc2 = makePc(await openDatabase(':memory:'), backend)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  it('PC1 의 searchEngine=naver 가 PC2 첫 로그인 뒤에도 그대로다', async () => {
    // PC1: 설정을 바꾸고(훅이 변경 로그를 남긴다) 한 주기를 돈다
    pc1.settings.set({ searchEngine: 'naver' })
    new SyncLocal(pc1.db).setStateNumber(settingUpdatedAtKey('searchEngine'), Date.now())
    pc1.outbox.record('settings', 'searchEngine', 'upsert', undefined, 1)
    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await cycle(pc1)

    const onServer = backend
      .keyedRows('settings_sync')
      .find((r) => String(r.key) === 'searchEngine')
    expect(onServer?.value).toBe('naver')

    // PC2: 기본값(google)인 채로 첫 로그인 — 최초 업로드에는 설정이 들어 있지 않다
    const backfilled = backfillOutbox(pc2.db, pc2.deps.workspace(), pc2.vault)
    expect(backfilled.settings).toBe(0)
    await cycle(pc2)

    // PC2 가 naver 를 받았다
    expect(pc2.settings.get().searchEngine).toBe('naver')
    // 서버 값도 그대로다 — PC2 가 자기 기본값으로 덮지 않았다
    expect(
      backend.keyedRows('settings_sync').find((r) => String(r.key) === 'searchEngine')?.value
    ).toBe('naver')

    // PC1 도 그대로다
    await cycle(pc1)
    expect(pc1.settings.get().searchEngine).toBe('naver')
  })

  it('서버에 없던 키는 풀 뒤에 올라간다', async () => {
    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await cycle(pc1)
    const keys = backend.keyedRows('settings_sync').map((r) => String(r.key))
    expect(keys).toContain('searchEngine')
    expect(keys).toContain('model')
  })

  it('설정 최초 업로드는 한 번만 돈다', async () => {
    await cycle(pc1)
    const first = backend.keyedRows('settings_sync').length
    expect(first).toBeGreaterThan(0)
    const again = backfillSettings(pc1.db, pc1.deps.workspace(), pc1.vault)
    expect(again.skipped).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C2 — 키 재료가 어긋난 주기에는 금고 커서를 고정한다
// ---------------------------------------------------------------------------
describe('C2 — 키 불일치 주기에는 vault_items 커서가 움직이지 않는다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend)
    pc2 = makePc(await openDatabase(':memory:'), backend)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  it('키를 맞추기 전에는 커서가 그대로고, 맞춘 뒤 다음 주기에 내려온다', async () => {
    // PC1 이 금고를 만들고 항목 하나를 올린다
    await pc1.vault.setup(MASTER)
    const account = pc1.vault.upsertAccount({ host: 'example.com', username: 'me' })
    pc1.vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    await pushAll(pc1.deps)
    expect(backend.rows('vault_items_sync')).toHaveLength(1)

    // PC2 는 **다른** 마스터 비밀번호로 금고를 먼저 만들어 둔다 → 키 재료 불일치
    await pc2.vault.setup('전혀-다른-비밀번호')

    const cursorKey = pullCursorKey(1, 'vault_items')
    const local2 = new SyncLocal(pc2.db)
    const pulled = await pullAll(pc2.deps)
    expect(pulled.vaultKeyMismatch || pulled.vaultDecryptFailed).toBe(true)
    // 커서가 전진하지 않았다 — 지금 넘기면 이 항목은 영영 내려오지 않는다
    expect(local2.getState(cursorKey)).toBeNull()

    // 키를 맞춘다(PC2 의 금고를 PC1 것으로 갈아 끼운 상태를 재현)
    pc2.vault.dispose()
    const db2b = await openDatabase(':memory:')
    const pc2b = makePc(db2b, backend)
    await pullAll(pc2b.deps)
    expect(await pc2b.vault.unlock(MASTER)).toBe(true)

    // 다음 주기에 금고 항목이 실제로 내려온다
    await pullAll(pc2b.deps)
    pc2b.vault.setWorkspaceScope({ id: 1, isDefault: true })
    const accounts = pc2b.vault.listAccounts('example.com')
    expect(accounts).toHaveLength(1)
    expect(pc2b.vault.reveal(pc2b.vault.listItems(accounts[0].id)[0].id)).toBe(SECRET)

    pc2b.vault.dispose()
    db2b.close()
  })
})

// ---------------------------------------------------------------------------
// I1 — 두 PC 가 로그인 전에 같은 CSV 를 가져온 경우 금고 항목이 배로 늘지 않는다
// ---------------------------------------------------------------------------
describe('I1 — 같은 항목을 각자 가져와도 중복이 생기지 않는다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend)
    pc2 = makePc(await openDatabase(':memory:'), backend)
    // 같은 마스터 키를 쓰는 두 PC 를 만든다(키 재료가 서버를 거쳐 건너간다)
    await pc1.vault.setup(MASTER)
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)
    expect(await pc2.vault.unlock(MASTER)).toBe(true)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  /** 살아 있는 금고 항목 수 */
  const live = (pc: Pc): number =>
    pc.db.drizzle
      .select()
      .from(vaultItemsTable)
      .all()
      .filter((r) => r.deletedAt === null).length

  it('동기화해도 금고 항목 수가 배로 늘지 않는다', async () => {
    // 두 PC 가 **로그인 전처럼** 훅 없이 같은 CSV 를 각자 가져온다.
    // 같은 항목이 양쪽에 서로 다른 로컬 id 로 들어가고, 원격 id 는 아직 없다
    for (const pc of [pc1, pc2]) {
      pc.vault.setOutboxRecorder(null)
      const account = pc.vault.upsertAccount({ host: 'shop.example', username: 'me' })
      pc.vault.putItem({ accountId: account.id, type: 'login', label: '쇼핑몰', value: SECRET })
      pc.signIn()
    }
    expect(live(pc1)).toBe(1)
    expect(live(pc2)).toBe(1)

    // PC1 이 먼저 올린다
    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await cycle(pc1)
    expect(backend.rows('vault_items_sync')).toHaveLength(1)

    // PC2 가 받아 본다 — 원격 id 는 모르지만 (계정, 종류, 라벨) 이 같아 기존 항목에 붙는다
    backfillOutbox(pc2.db, pc2.deps.workspace(), pc2.vault)
    await pullAll(pc2.deps)
    expect(live(pc2)).toBe(1)

    // 올리고 다시 받아도 양쪽 다 하나, 서버도 하나다
    await cycle(pc2)
    await cycle(pc1)
    await cycle(pc2)
    expect(live(pc1)).toBe(1)
    expect(live(pc2)).toBe(1)
    expect(backend.rows('vault_items_sync')).toHaveLength(1)
    // 값도 그대로 열린다
    const accounts = pc2.vault.listAccounts('shop.example')
    expect(pc2.vault.reveal(pc2.vault.listItems(accounts[0].id)[0].id)).toBe(SECRET)
  })

  it('라벨이 다르면 별개 항목으로 남는다', async () => {
    pc1.vault.setOutboxRecorder(null)
    const a1 = pc1.vault.upsertAccount({ host: 'shop.example', username: 'me' })
    pc1.vault.putItem({ accountId: a1.id, type: 'login', label: '쇼핑몰', value: SECRET })
    pc1.signIn()

    pc2.vault.setOutboxRecorder(null)
    const a2 = pc2.vault.upsertAccount({ host: 'shop.example', username: 'me' })
    pc2.vault.putItem({ accountId: a2.id, type: 'login', label: '다른 라벨', value: SECRET })
    pc2.signIn()

    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await cycle(pc1)
    backfillOutbox(pc2.db, pc2.deps.workspace(), pc2.vault)
    await cycle(pc2)
    await cycle(pc1)

    expect(live(pc1)).toBe(2)
    expect(backend.rows('vault_items_sync')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// I2 — 채팅도 최초 업로드·시각 올림 대상이다
// ---------------------------------------------------------------------------
describe('I2 — 로그인 전에 쌓인 채팅도 올라간다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend, false)
    pc2 = makePc(await openDatabase(':memory:'), backend)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  it('최초 업로드가 대화·메시지를 대기열에 올린다', async () => {
    const chat = pc1.chats.create('로그인 전 대화')
    pc1.chats.append({ chatId: chat.id, role: 'user', content: '안녕' })
    pc1.chats.append({ chatId: chat.id, role: 'assistant', content: '반가워' })
    // 훅이 없었으니 변경 로그는 비어 있다
    expect(pc1.outbox.count()).toBe(0)

    pc1.signIn()
    const result = backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    expect(result.chats).toBe(1)
    expect(result.chatMessages).toBe(2)

    await pushAll(pc1.deps)
    expect(backend.rows('chats_sync')).toHaveLength(1)
    expect(backend.rows('chat_messages_sync')).toHaveLength(2)

    await pullAll(pc2.deps)
    const list = pc2.chats.list()
    expect(list.map((c) => c.title)).toEqual(['로그인 전 대화'])
    expect(pc2.chats.get(list[0].id)?.messages.map((m) => m.content)).toEqual(['안녕', '반가워'])
  })

  it('커서가 이미 앞서 있는 PC2 에도 옛 채팅이 도달한다(시각 올림)', async () => {
    const chat = pc1.chats.create('어제 대화')
    pc1.chats.append({ chatId: chat.id, role: 'user', content: '어제 이야기' })

    // PC2 의 커서를 오늘까지 밀어 둔다
    pc2.bookmarks.createLink(null, 'PC2 북마크', 'https://pc2.example')
    await pushAll(pc2.deps)
    await pullAll(pc2.deps)

    pc1.signIn()
    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await pushAll(pc1.deps)

    await pullAll(pc2.deps)
    expect(pc2.chats.list().map((c) => c.title)).toContain('어제 대화')
  })
})

// ---------------------------------------------------------------------------
// M7 — 재검사는 대기열에 이미 있는 행의 수정 시각을 건드리지 않는다
// ---------------------------------------------------------------------------
describe('M7 — 재검사는 새로 넣은 행만 시각을 올린다', () => {
  let backend: FakeBackend
  let pc1: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend, false)
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc1.db.close()
  })

  it('대기열에 이미 있던 행의 updated_at 은 그대로다', async () => {
    pc1.signIn()
    pc1.bookmarks.createLink(null, '대기 중 북마크', 'https://queued.example')
    expect(pc1.outbox.count()).toBe(1)

    const before = pc1.db.drizzle.select().from(vaultItemsTable).all()
    expect(before).toHaveLength(0)

    const bookmarkBefore = pc1.bookmarks.tree().links[0]
    const atBefore = new SyncLocal(pc1.db).bookmarkForSync(bookmarkBefore.id)?.updatedAt ?? 0

    await new Promise((resolve) => setTimeout(resolve, 5))
    const verified = verifyBackfill(pc1.db, pc1.deps.workspace(), pc1.vault)
    // 이미 대기열에 있으니 세지도, 시각을 올리지도 않는다
    expect(verified.bookmarks).toBe(0)
    const atAfter = new SyncLocal(pc1.db).bookmarkForSync(bookmarkBefore.id)?.updatedAt ?? 0
    expect(atAfter).toBe(atBefore)
  })

  it('변경 로그를 놓친 행은 여전히 보충하고 시각을 올린다', async () => {
    pc1.signIn()
    backfillOutbox(pc1.db, pc1.deps.workspace(), pc1.vault)
    await pushAll(pc1.deps)

    // 훅 없이 생긴 행(가져오기 직후 등)
    pc1.bookmarks.setOutboxRecorder(null)
    pc1.bookmarks.createLink(null, '놓친 북마크', 'https://missed.example')
    pc1.signIn()

    const verified = verifyBackfill(pc1.db, pc1.deps.workspace(), pc1.vault)
    expect(verified.bookmarks).toBe(1)
  })
})
