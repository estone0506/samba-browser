// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 로그인 ↔ 동기화 엔진 연결. 네트워크 없이 가짜 백엔드로만 검증한다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { AuthService } from '../src/main/sync/auth'
import { SyncConnection, workspaceRemoteId } from '../src/main/sync/connect'
import { DEVICES_TABLE } from '../src/main/sync/devices'
import { SyncEngineHolder, SYNC_POLL_INTERVAL_MS } from '../src/main/sync/engine'
import { SyncOutbox } from '../src/main/sync/outbox'
import type { SyncSettingsTarget, OutboxTarget } from '../src/main/sync/connect'
import { createFakeBackend, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { OutboxRecorder } from '../src/shared/sync'

const MASTER = 'master-pass-1234'
const EMAIL = 'me@example.com'

function makeSettings(): SyncSettingsTarget {
  let value: Settings = { ...DEFAULT_SETTINGS }
  let recorder: OutboxRecorder | null = null
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    },
    setOutboxRecorder: (r) => {
      recorder = r
    },
    // 단언용 — 훅이 붙었는지 본다
    get recorder(): OutboxRecorder | null {
      return recorder
    }
  } as SyncSettingsTarget & { recorder: OutboxRecorder | null }
}

function makeBookmarks(): OutboxTarget & { recorder: OutboxRecorder | null } {
  let recorder: OutboxRecorder | null = null
  return {
    setOutboxRecorder: (r) => {
      recorder = r
    },
    get recorder(): OutboxRecorder | null {
      return recorder
    }
  }
}

describe('SyncConnection', () => {
  let db: Db
  let backend: FakeBackend
  let vault: VaultService
  let auth: AuthService
  let holder: SyncEngineHolder
  let outbox: SyncOutbox
  let settings: SyncSettingsTarget & { recorder: OutboxRecorder | null }
  let bookmarks: ReturnType<typeof makeBookmarks>
  let connection: SyncConnection
  // 작업공간 전환을 흉내낸다 — 엔진은 주기마다 이 값을 다시 읽는다
  let activeWorkspaceId: number

  beforeEach(async () => {
    activeWorkspaceId = 1
    vi.useFakeTimers()
    db = await openDatabase(':memory:')
    backend = createFakeBackend()
    outbox = new SyncOutbox(db)
    settings = makeSettings() as SyncSettingsTarget & { recorder: OutboxRecorder | null }
    bookmarks = makeBookmarks()
    vault = new VaultService(db, { get: settings.get })
    await vault.setup(MASTER)
    auth = new AuthService({
      backend,
      configured: true,
      openExternal: async () => {}
    })
    holder = new SyncEngineHolder()
    connection = new SyncConnection({
      db,
      backend,
      auth,
      holder,
      vault,
      settings,
      bookmarks,
      workspace: () => ({
        localId: activeWorkspaceId,
        remoteId: workspaceRemoteId(db, activeWorkspaceId)
      }),
      device: {
        hostname: () => '내-PC',
        osLabel: () => 'Windows_NT 10.0.26200',
        appVersion: () => '0.1.0'
      }
    })
  })

  afterEach(() => {
    connection.dispose()
    vault.dispose()
    db.close()
    vi.useRealTimers()
  })

  it('로그인하면 기기를 등록하고 엔진을 시작한다', async () => {
    await auth.signIn(EMAIL, 'password-1234')
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.rows(DEVICES_TABLE)).toHaveLength(1)
    // AuthState 에 기기 id 가 채워진다(토큰은 어디에도 없다)
    expect(auth.state().deviceId).toBe(backend.rows(DEVICES_TABLE)[0].id)
    expect(holder.current()).not.toBeNull()
    expect(holder.status().online).toBe(true)
    // 저장소에 변경 로그 훅이 붙어 다음 주기에 전송된다
    expect(settings.recorder).not.toBeNull()
    expect(bookmarks.recorder).not.toBeNull()
    vault.upsertAccount({ host: 'example.com', username: 'me' })
    expect(outbox.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)
    expect(backend.rows('accounts_sync')).toHaveLength(1)
  })

  it('기기가 취소되면 다음 주기에 로그아웃하고 금고를 잠근다', async () => {
    await auth.signIn(EMAIL, 'password-1234')
    await vi.advanceTimersByTimeAsync(0)
    const mine = String(backend.rows(DEVICES_TABLE)[0].id)
    expect(vault.state()).toBe('unlocked')

    // 다른 PC 에서 이 기기를 원격 로그아웃시킨다
    const devices = connection.devices()
    expect(devices).not.toBeNull()
    await devices!.revoke(mine)
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)

    expect(auth.state().signedIn).toBe(false)
    expect(auth.state().deviceId).toBeNull()
    expect(vault.state()).toBe('locked')
    expect(holder.current()).toBeNull()
    expect(connection.devices()).toBeNull()
    // 훅이 떨어져 로그아웃 뒤의 변경은 쌓이지 않는다
    expect(settings.recorder).toBeNull()
    expect(bookmarks.recorder).toBeNull()
  })

  it('로그아웃하면 엔진을 세우고 훅을 떼고 금고를 잠근다', async () => {
    await auth.signIn(EMAIL, 'password-1234')
    await vi.advanceTimersByTimeAsync(0)
    const before = backend.calls.select

    await auth.signOut()
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 2)

    expect(holder.current()).toBeNull()
    expect(vault.state()).toBe('locked')
    expect(settings.recorder).toBeNull()
    // 더 이상 서버를 부르지 않는다
    expect(backend.calls.select).toBe(before)
  })

  it('토큰이 만료되면 로그아웃하고 금고를 잠근다', async () => {
    await auth.signIn(EMAIL, 'password-1234')
    await vi.advanceTimersByTimeAsync(0)

    backend.expireAuth()
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)

    expect(auth.state().signedIn).toBe(false)
    expect(vault.state()).toBe('locked')
    expect(holder.current()).toBeNull()
  })

  it('작업공간을 바꾸면 다음 주기의 푸시 payload 가 새 uuid 로 올라간다', async () => {
    // 예전에는 엔진 생성 시 uuid 를 한 번만 읽어, B 작업공간의 변경이 A 의 uuid 로 올라갔다
    await auth.signIn(EMAIL, 'password-1234')
    await vi.advanceTimersByTimeAsync(0)

    vault.upsertAccount({ host: 'a.example', username: 'a' })
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)
    const first = backend.rows('accounts_sync').find((r) => r.host === 'a.example')
    expect(first?.workspace_id).toBe(workspaceRemoteId(db, 1))

    // 작업공간 전환 — 엔진은 그대로 돌고, 다음 주기에 새 uuid 를 읽는다
    activeWorkspaceId = 2
    vault.upsertAccount({ host: 'b.example', username: 'b' })
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)

    const second = backend.rows('accounts_sync').find((r) => r.host === 'b.example')
    expect(second?.workspace_id).toBe(workspaceRemoteId(db, 2))
    expect(second?.workspace_id).not.toBe(first?.workspace_id)
  })

  it('작업공간 원격 uuid 는 한 번 정해지면 그대로다', () => {
    const first = workspaceRemoteId(db, 1)
    expect(workspaceRemoteId(db, 1)).toBe(first)
    expect(workspaceRemoteId(db, 2)).not.toBe(first)
  })
})
