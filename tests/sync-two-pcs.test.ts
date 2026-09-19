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
import { ChatRepo } from '../src/main/chat/repo'
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
  chats: ChatRepo
  outbox: SyncOutbox
  deps: PushDeps
}

function makePc(db: Db, backend: FakeBackend): Pc {
  const outbox = new SyncOutbox(db)
  const settings = makeSettings()
  const vault = new VaultService(db, { get: settings.get })
  const bookmarks = new BookmarkRepo(db)
  const chats = new ChatRepo(db)
  chats.setWorkspaceScope({ id: 1, isDefault: true })
  // 각 PC 는 자기 DB 에서 기본 작업공간(로컬 id 1)의 원격 uuid 를 스스로 구한다
  const workspace = (): { localId: number; remoteId: string } => ({
    localId: 1,
    remoteId: workspaceRemoteId(db, 1, true)
  })
  const recorder = createOutboxRecorder(db, outbox, () => 1)
  vault.setOutboxRecorder(recorder)
  bookmarks.setOutboxRecorder(recorder)
  chats.setOutboxRecorder(recorder)
  return {
    db,
    vault,
    bookmarks,
    chats,
    outbox,
    deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace }
  }
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

describe('AI 채팅 기록이 두 PC 사이를 오간다', () => {
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

  it('A 의 대화와 메시지가 B 에 그대로 보인다', async () => {
    const chat = pc1.chats.create('구글 검색')
    pc1.chats.append({ chatId: chat.id, role: 'user', content: '구글 열어줘' })
    pc1.chats.append({
      chatId: chat.id,
      role: 'assistant',
      content: '열었습니다',
      steps: [{ label: '이동: google.com', ok: true }]
    })

    const pushed = await pushAll(pc1.deps)
    expect(pushed.failed).toBe(0)
    expect(backend.rows('chats_sync')).toHaveLength(1)
    expect(backend.rows('chat_messages_sync')).toHaveLength(2)

    await pullAll(pc2.deps)

    const list = pc2.chats.list()
    expect(list.map((c) => c.title)).toEqual(['구글 검색'])
    const detail = pc2.chats.get(list[0].id)
    expect(detail?.messages.map((m) => m.content)).toEqual(['구글 열어줘', '열었습니다'])
    expect(detail?.messages[1].steps).toEqual([{ label: '이동: google.com', ok: true }])
  })

  it('B 에서 지운 대화는 A 에서도 사라진다', async () => {
    const chat = pc1.chats.create('지울 대화')
    pc1.chats.append({ chatId: chat.id, role: 'user', content: '안녕' })
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)

    const onPc2 = pc2.chats.list()[0]
    expect(onPc2).toBeTruthy()
    // 삭제 시각이 원래 수정 시각보다 확실히 뒤가 되도록 한 틱 쉰다(LWW 는 큰 쪽이 이긴다)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(pc2.chats.remove(onPc2.id)).toBe(true)
    await pushAll(pc2.deps)

    await pullAll(pc1.deps)
    expect(pc1.chats.list()).toEqual([])
    expect(pc1.chats.get(chat.id)).toBeNull()
  })

  it('올라간 메시지 어디에도 비밀 문자열이 없다', async () => {
    const chat = pc1.chats.create('로그인')
    pc1.chats.append({
      chatId: chat.id,
      role: 'assistant',
      content: '로그인했습니다',
      // 도구가 실수로 값을 덧붙였다고 가정한다(실제 경로에는 없다)
      steps: [{ label: '로그인: example.com (내 계정)', ok: true, password: SECRET } as never]
    })
    await pushAll(pc1.deps)

    const uploaded = JSON.stringify(backend.rows('chat_messages_sync'))
    expect(uploaded).toContain('로그인: example.com (내 계정)')
    expect(uploaded).not.toContain(SECRET)
  })
})
