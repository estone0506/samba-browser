// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 푸시 — 변경 로그를 원격으로 보낸다. 금고는 봉투 암호화 후 암호문만 올라간다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { SyncLocal } from '../src/main/sync/local'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { VAULT_SYNC_ALLOWED_KEYS } from '../src/main/sync/guard'
import { AuthExpiredError } from '../src/main/sync/backend'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

// vi.mock 은 파일 맨 위로 끌어올려지므로, 켜고 끌 수 있는 깃발을 hoisted 로 만든다
const leak = vi.hoisted(() => ({ on: false }))

vi.mock('../src/main/sync/mappers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/sync/mappers')>()
  return {
    ...actual,
    vaultItemToRemote: (
      row: Parameters<typeof actual.vaultItemToRemote>[0],
      ctx: Parameters<typeof actual.vaultItemToRemote>[1]
    ) => {
      const mapped = actual.vaultItemToRemote(row, ctx)
      // 매퍼가 실수로 평문 컬럼을 끼워 넣은 상황을 재현한다
      return leak.on ? { ...mapped, password: 'sup3rs3cret!' } : mapped
    }
  }
})

const MASTER = 'master-pass-1234'
const SECRET = 'sup3rs3cret!'
const WORKSPACE = '00000000-0000-4000-8000-0000000000ws'

function makeSettings(patch: Partial<Settings> = {}): SettingsAccess {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

describe('pushAll', () => {
  let db: Db
  let vault: VaultService
  let outbox: SyncOutbox
  let backend: FakeBackend
  let deps: PushDeps

  beforeEach(async () => {
    leak.on = false
    db = await openDatabase(':memory:')
    outbox = new SyncOutbox(db)
    backend = createFakeBackend()
    const settings = makeSettings()
    vault = new VaultService(db, { get: settings.get })
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox))
    await vault.setup(MASTER)
    // 금고 설정이 남기는 마스터 키 재료 변경 로그는 이 파일의 관심사가 아니다
    // (키 재료 동기화는 sync-two-pcs 가 다룬다). 전송 건수 단언을 흐리지 않게 비운다
    outbox.clear(outbox.pendingFor('settings').map((r) => r.id))
    deps = {
      db,
      backend,
      outbox,
      vault,
      settings,
      userId: FAKE_USER_ID,
      workspace: () => ({ localId: 1, remoteId: WORKSPACE })
    }
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('계정을 보내고 remote_id 를 로컬에 적는다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    const result = await pushAll(deps)

    expect(result.sent).toBe(1)
    const rows = backend.rows('accounts_sync')
    expect(rows).toHaveLength(1)
    expect(rows[0].host).toBe('example.com')
    expect(rows[0].username).toBe('me')
    expect(rows[0].user_id).toBe(FAKE_USER_ID)
    expect(rows[0].workspace_id).toBe(WORKSPACE)

    const local = new SyncLocal(db)
    expect(local.accountForSync(account.id)?.remoteId).toBe(rows[0].id)
    expect(outbox.count()).toBe(0)
  })

  it('금고 항목은 허용 컬럼만, 평문 없이 올라간다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })

    await pushAll(deps)

    const rows = backend.rows('vault_items_sync')
    expect(rows).toHaveLength(1)
    for (const key of Object.keys(rows[0])) {
      expect(VAULT_SYNC_ALLOWED_KEYS).toContain(key)
    }
    expect(rows[0].account_id).toBe(backend.rows('accounts_sync')[0].id)
    expect(rows[0].aad).toBe(`sync:vault_items:${rows[0].id}`)

    // 행 전체를 문자열로 바꿔도 저장했던 평문이 어디에도 없어야 한다
    const dumped = JSON.stringify(rows[0]) + String(rows[0].fields_ciphertext)
    expect(dumped).not.toMatch(/sup3rs3cret/)
  })

  it('금고가 잠겨 있으면 금고 항목만 건너뛰고 변경 로그에 남긴다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    vault.lock()

    const result = await pushAll(deps)

    expect(result.skipped).toBe(1)
    expect(backend.rows('vault_items_sync')).toHaveLength(0)
    // 계정은 올라갔고, 금고 항목만 남는다
    expect(backend.rows('accounts_sync')).toHaveLength(1)
    expect(outbox.pendingFor('vault_items')).toHaveLength(1)
  })

  it('금지 컬럼이 섞이면 그 표 전체 전송을 중단하고 변경 로그를 보존한다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    vault.putItem({ accountId: null, type: 'note', label: '메모', value: '메모 내용' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    leak.on = true

    const result = await pushAll(deps)

    expect(result.failed).toBe(2)
    expect(backend.rows('vault_items_sync')).toHaveLength(0)
    expect(outbox.pendingFor('vault_items')).toHaveLength(2)
    expect(outbox.pendingFor('vault_items')[0].error).toContain('vault_items_sync')
    expect(errors).toHaveBeenCalledWith('동기화 중단: 평문 검사 실패', expect.any(String))
    // 에러 로그에 값이 들어가면 안 된다
    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/sup3rs3cret/)
    }
    errors.mockRestore()
  })

  it('북마크는 폴더 트리에서 folder_path 를 계산해 올린다', async () => {
    const repo = new BookmarkRepo(db)
    repo.setOutboxRecorder(createOutboxRecorder(db, outbox))
    const bar = repo.createFolder(null, '북마크바')
    const dev = repo.createFolder(bar, '개발')
    repo.createLink(dev, '깃허브', 'https://github.com')

    await pushAll(deps)

    const rows = backend.rows('bookmarks_sync')
    expect(rows).toHaveLength(1)
    expect(rows[0].folder_path).toBe('북마크바/개발')
    expect(rows[0].url).toBe('https://github.com')
  })

  it('설정은 키별로 복합 PK 표에 올린다', async () => {
    const settings = deps.settings
    const recorder = createOutboxRecorder(db, outbox)
    settings.set({ language: 'en' })
    recorder('settings', 'language', 'upsert')

    const result = await pushAll(deps)

    expect(result.sent).toBe(1)
    const rows = backend.keyedRows('settings_sync')
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('language')
    expect(rows[0].value).toBe('en')
    expect(rows[0].user_id).toBe(FAKE_USER_ID)
    expect(rows[0].id).toBeUndefined()
  })

  it('동기화 대상이 아닌 설정 키는 버리면서 키 이름을 로그로 남긴다', async () => {
    // 조용히 사라지면 "왜 안 올라가지" 를 추적할 수 없다
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    outbox.record('settings', 'lastUrl', 'upsert')

    const result = await pushAll(deps)

    expect(result.sent).toBe(0)
    expect(backend.keyedRows('settings_sync')).toHaveLength(0)
    expect(outbox.count()).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      '동기화 대상이 아닌 설정 키라 변경 로그에서 버립니다',
      'lastUrl'
    )
    warn.mockRestore()
  })

  it('삭제한 항목은 삭제 표식(tombstone)으로 올라간다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    const item = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: SECRET
    })
    await pushAll(deps)
    vault.deleteItem(item.id)

    await pushAll(deps)

    const rows = backend.rows('vault_items_sync')
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).not.toBeNull()
    // 삭제 표식의 updated_at 은 삭제 시각 이상이어야 다른 PC 의 풀 커서를 통과한다
    expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(rows[0].deleted_at as string).getTime()
    )
  })

  it('네트워크 오류가 나면 변경 로그가 보존되고 다음 시도에 전송된다', async () => {
    vault.upsertAccount({ host: 'example.com', username: 'me' })
    backend.failWith(new Error('연결 실패'))

    const failedResult = await pushAll(deps)
    expect(failedResult.failed).toBe(1)
    expect(outbox.count()).toBe(1)
    expect(outbox.pending()[0].error).toBe('연결 실패')

    backend.failWith(null)
    const okResult = await pushAll(deps)
    expect(okResult.sent).toBe(1)
    expect(outbox.count()).toBe(0)
  })

  it('인증이 만료되면 그대로 던지고 변경 로그를 보존한다', async () => {
    vault.upsertAccount({ host: 'example.com', username: 'me' })
    backend.expireAuth()

    await expect(pushAll(deps)).rejects.toBeInstanceOf(AuthExpiredError)
    expect(outbox.count()).toBe(1)
  })

  it('전환 전에 쌓인 변경은 원래 작업공간의 uuid 로 올라간다', async () => {
    // New-I3 — 예전에는 푸시 시점의 활성 작업공간 uuid 를 모든 대기 행에 찍어,
    // 1번에서 만든 계정이 2번 작업공간의 행으로 올라갔다
    const WS2 = '00000000-0000-4000-8000-00000000ws02'
    new SyncLocal(db).setState('workspace:1:remoteId', WORKSPACE)
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox, () => 1))
    vault.upsertAccount({ host: 'old.example', username: 'old' })
    // 아직 보내지 못한 채 2번 작업공간으로 옮겼다
    const switched: PushDeps = { ...deps, workspace: () => ({ localId: 2, remoteId: WS2 }) }
    vault.setWorkspaceScope({ id: 2, isDefault: false })
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox, () => 2))
    vault.upsertAccount({ host: 'new.example', username: 'new' })

    await pushAll(switched)

    const rows = backend.rows('accounts_sync')
    expect(rows.find((r) => r.host === 'old.example')?.workspace_id).toBe(WORKSPACE)
    expect(rows.find((r) => r.host === 'new.example')?.workspace_id).toBe(WS2)
  })

  it('작업공간을 모르는 옛 행은 활성 작업공간으로 올린다', async () => {
    vault.upsertAccount({ host: 'legacy.example', username: 'me' })
    expect(outbox.pending()[0].workspaceId).toBeNull()

    await pushAll(deps)

    expect(backend.rows('accounts_sync')[0].workspace_id).toBe(WORKSPACE)
  })
})
