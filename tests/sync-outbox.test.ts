// 변경 로그(sync_outbox) — 같은 행의 변경은 접어서 최신 1건만 남긴다

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { syncOutbox } from '../src/main/db/schema'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'

describe('SyncOutbox', () => {
  let db: Db
  let outbox: SyncOutbox

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    outbox = new SyncOutbox(db)
  })

  afterEach(() => {
    db.close()
  })

  it('기록하면 대기 건수가 늘어난다', () => {
    outbox.record('accounts', '1', 'upsert')
    expect(outbox.count()).toBe(1)
    const [row] = outbox.pending()
    expect(row.table).toBe('accounts')
    expect(row.rowId).toBe('1')
    expect(row.op).toBe('upsert')
    expect(row.payload).toBeNull()
  })

  it('같은 행을 두 번 upsert 하면 최신 1건만 남는다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.record('accounts', '1', 'upsert')
    expect(outbox.count()).toBe(1)
  })

  it('다른 행은 접히지 않는다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.record('accounts', '2', 'upsert')
    outbox.record('bookmarks', '1', 'upsert')
    expect(outbox.count()).toBe(3)
  })

  it('upsert 뒤 delete 를 기록하면 delete 만 남는다', () => {
    outbox.record('vault_items', '7', 'upsert')
    outbox.record('vault_items', '7', 'delete', JSON.stringify({ remoteId: 'uuid-7' }))
    const rows = outbox.pending()
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('delete')
    expect(rows[0].payload).toBe(JSON.stringify({ remoteId: 'uuid-7' }))
  })

  it('clear 로 보낸 건을 지운다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.record('accounts', '2', 'upsert')
    const ids = outbox.pending().map((r) => r.id)
    outbox.clear([ids[0]])
    expect(outbox.count()).toBe(1)
    expect(outbox.pending()[0].rowId).toBe('2')
  })

  it('빈 배열로 clear 하면 아무것도 지우지 않는다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.clear([])
    expect(outbox.count()).toBe(1)
  })

  it('markFailed 는 error 와 triedAt 을 남기고 행은 보존한다', () => {
    outbox.record('accounts', '1', 'upsert')
    const before = outbox.pending()[0]
    expect(before.error).toBeNull()
    expect(before.triedAt).toBeNull()

    outbox.markFailed([before.id], '네트워크 오류')
    const after = outbox.pending()[0]
    expect(outbox.count()).toBe(1)
    expect(after.error).toBe('네트워크 오류')
    expect(after.triedAt).not.toBeNull()
  })

  it('pending 은 limit 만큼만, 오래된 순으로 돌려준다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.record('accounts', '2', 'upsert')
    outbox.record('accounts', '3', 'upsert')
    const rows = outbox.pending(2)
    expect(rows.map((r) => r.rowId)).toEqual(['1', '2'])
  })

  it('표별로 골라 읽을 수 있다', () => {
    outbox.record('accounts', '1', 'upsert')
    outbox.record('bookmarks', '9', 'upsert')
    expect(outbox.pendingFor('bookmarks').map((r) => r.rowId)).toEqual(['9'])
  })

  it('기록 시점의 작업공간을 행에 남긴다', () => {
    // New-I3 — 예전에는 행에 작업공간이 없어, 푸시 시점의 활성 작업공간 uuid 가
    // 전환 전에 쌓인 변경에까지 찍혔다
    outbox.record('accounts', '1', 'upsert', undefined, 2)
    expect(outbox.pending()[0].workspaceId).toBe(2)
  })

  it('작업공간을 주지 않으면 null 로 남는다(옛 행과 같은 취급)', () => {
    outbox.record('accounts', '1', 'upsert')
    expect(outbox.pending()[0].workspaceId).toBeNull()
  })

  it('기록 훅이 활성 작업공간을 따라간다', () => {
    let active = 1
    const recorder = createOutboxRecorder(db, outbox, () => active)
    recorder('bookmarks', '1', 'upsert')
    active = 3
    recorder('bookmarks', '2', 'upsert')
    expect(outbox.pending().map((r) => r.workspaceId)).toEqual([1, 3])
  })

  it('알 수 없는 표 이름이 섞여 있어도 pending 에서 걸러진다', () => {
    outbox.record('accounts', '1', 'upsert')
    // 옛 버전이 남긴 행이나 손상된 값이 들어 있어도 pending 이 죽지 않아야 한다
    db.drizzle
      .insert(syncOutbox)
      .values({ table: 'audit_log', rowId: '1', op: 'upsert', createdAt: Date.now() })
      .run()
    expect(outbox.pending().map((r) => r.table)).toEqual(['accounts'])
  })
})
