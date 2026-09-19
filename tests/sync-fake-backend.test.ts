// 이후 모든 sync 테스트가 의존하는 가짜 백엔드 자체를 먼저 검증한다
import { describe, it, expect } from 'vitest'
import { createFakeBackend, FAKE_USER_ID } from './stubs/fake-backend'
import { AuthExpiredError } from '../src/main/sync/backend'
import { SYNC_TABLES } from '../src/shared/sync'

describe('createFakeBackend', () => {
  it('로그인하면 고정 userId 를 주고 로그아웃하면 사라진다', async () => {
    const be = createFakeBackend()
    expect(await be.currentUser()).toBeNull()
    const user = await be.signIn('me@example.com', 'pw')
    expect(user).toEqual({ userId: FAKE_USER_ID, email: 'me@example.com' })
    expect(await be.currentUser()).toEqual(user)
    await be.signOut()
    expect(await be.currentUser()).toBeNull()
  })

  it('upsert 는 id 로 덮어쓴다', async () => {
    const be = createFakeBackend()
    await be.upsert('accounts_sync', [{ id: 'a', label: '처음', updated_at: 10 }])
    await be.upsert('accounts_sync', [{ id: 'a', label: '나중', updated_at: 20 }])
    expect(be.rows('accounts_sync')).toEqual([{ id: 'a', label: '나중', updated_at: 20 }])
  })

  it('select 는 updated_at 이 since 보다 큰 행만 오래된 순으로 준다', async () => {
    const be = createFakeBackend()
    be.seed('bookmarks_sync', [
      { id: 'c', updated_at: 30 },
      { id: 'a', updated_at: 10 },
      { id: 'b', updated_at: 20 }
    ])
    const got = await be.select('bookmarks_sync', 10)
    expect(got.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('ISO 문자열 updated_at 도 비교할 수 있다', async () => {
    const be = createFakeBackend()
    be.seed('bookmarks_sync', [{ id: 'a', updated_at: new Date(5_000).toISOString() }])
    expect(await be.select('bookmarks_sync', 1_000)).toHaveLength(1)
    expect(await be.select('bookmarks_sync', 9_000)).toHaveLength(0)
  })

  it('remove 는 해당 id 만 지운다', async () => {
    const be = createFakeBackend()
    be.seed('accounts_sync', [
      { id: 'a', updated_at: 1 },
      { id: 'b', updated_at: 1 }
    ])
    await be.remove('accounts_sync', ['a'])
    expect(be.rows('accounts_sync').map((r) => r.id)).toEqual(['b'])
  })

  it('subscribe 한 콜백은 fire 로만 발화하고 해제하면 더 울리지 않는다', async () => {
    const be = createFakeBackend()
    let hits = 0
    const off = await be.subscribe('accounts_sync', () => {
      hits += 1
    })
    be.fire('accounts_sync')
    expect(hits).toBe(1)
    be.fire('bookmarks_sync')
    expect(hits).toBe(1)
    off()
    be.fire('accounts_sync')
    expect(hits).toBe(1)
  })

  it('expireAuth 후에는 AuthExpiredError 를 던진다', async () => {
    const be = createFakeBackend()
    be.expireAuth()
    await expect(be.select('accounts_sync', 0)).rejects.toBeInstanceOf(AuthExpiredError)
  })

  it('호출 횟수를 기록한다', async () => {
    const be = createFakeBackend()
    await be.select('accounts_sync', 0)
    await be.upsert('accounts_sync', [{ id: 'a' }])
    await be.remove('accounts_sync', ['a'])
    expect(be.calls).toEqual({ select: 1, upsert: 1, remove: 1 })
  })

  it('감사 로그는 동기화 대상이 아니다', () => {
    expect(SYNC_TABLES).toEqual([
      'settings',
      'accounts',
      'vault_items',
      'bookmarks',
      'chats',
      'chat_messages'
    ])
    expect(SYNC_TABLES).not.toContain('audit_log')
  })
})
