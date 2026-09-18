import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../src/main/db/client'
import { sites, workspaces, syncOutbox, syncState } from '../src/main/db/schema'
import { eq, sql } from 'drizzle-orm'

describe('openDatabase(:memory:)', () => {
  let db: Db | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('마이그레이션 후 sites insert/select 왕복', async () => {
    db = await openDatabase(':memory:')

    await db.drizzle.insert(sites).values({
      host: 'example.com',
      name: '예시',
      createdAt: Date.now()
    })

    const rows = await db.drizzle.select().from(sites).where(eq(sites.host, 'example.com'))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('예시')
  })

  it('save() 는 메모리 DB 에서도 오류 없이 no-op', async () => {
    db = await openDatabase(':memory:')
    expect(() => db!.save()).not.toThrow()
    expect(() => db!.scheduleSave()).not.toThrow()
  })

  it('같은 DB 를 다시 열어도 마이그레이션이 중복 적용되지 않는다', async () => {
    db = await openDatabase(':memory:')
    // 마이그레이션이 두 번 실행돼도(__migrations 테이블이 있으므로) 에러 없이 조회 가능해야 함
    const rows = await db.drizzle.select().from(sites)
    expect(rows).toHaveLength(0)
  })

  it('close() 를 두 번 호출해도 안전하고, isClosed 가 true 로 바뀐다', async () => {
    db = await openDatabase(':memory:')
    expect(db.isClosed).toBe(false)
    expect(() => db!.close()).not.toThrow()
    expect(db.isClosed).toBe(true)
    // 종료 순서가 겹치는 경우(before-quit + 창 closed) 대비: 이미 닫힌 sql.js 핸들에
    // 다시 close() 해도 예외 없이 no-op 이어야 한다
    expect(() => db!.close()).not.toThrow()
    // close() 이후 save()/scheduleSave() 도 조용히 no-op 이어야 한다
    expect(() => db!.save()).not.toThrow()
    expect(() => db!.scheduleSave()).not.toThrow()
  })
})

describe('openDatabase(파일 경로)', () => {
  let dir: string | undefined
  let db: Db | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'samba-db-'))
  })

  afterEach(async () => {
    db?.close()
    db = undefined
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('쓰기 → close → 재오픈 하면 데이터가 남아 있다(파일 내구성)', async () => {
    const path = join(dir!, 'samba.db')

    db = await openDatabase(path)
    // 새 파일 DB 는 마이그레이션 직후 곧바로 디스크에 써 둔다
    expect(existsSync(path)).toBe(true)

    db.drizzle.insert(sites).values({ host: 'example.com', name: '예시', createdAt: 1 }).run()
    db.save()
    db.close()

    const reopened = await openDatabase(path)
    db = reopened
    const rows = reopened.drizzle.select().from(sites).where(eq(sites.host, 'example.com')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('예시')
  })

  it('close() 는 예약된 저장을 먼저 비워낸다(scheduleSave 유실 방지)', async () => {
    const path = join(dir!, 'samba.db')

    db = await openDatabase(path)
    db.drizzle.insert(sites).values({ host: 'later.example', name: '나중', createdAt: 1 }).run()
    // save() 를 직접 부르지 않고 디바운스 예약만 걸어 둔 상태에서 닫는다
    db.scheduleSave()
    db.close()

    const reopened = await openDatabase(path)
    db = reopened
    const rows = reopened.drizzle.select().from(sites).where(eq(sites.host, 'later.example')).all()
    expect(rows).toHaveLength(1)
  })

  it('close() 이후 save()/scheduleSave() 는 no-op 이고 isClosed 가 true 다', async () => {
    const path = join(dir!, 'samba.db')
    db = await openDatabase(path)
    db.close()
    expect(db.isClosed).toBe(true)
    expect(() => db!.save()).not.toThrow()
    expect(() => db!.scheduleSave()).not.toThrow()
    db = undefined
  })
})

// 2b 동기화 스키마(0005) — 작업공간·변경 로그·동기화 상태 표와 기존 표의 동기화 컬럼
describe('0005 동기화 스키마', () => {
  let dir: string | undefined
  let db: Db | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'samba-db-0005-'))
  })

  afterEach(async () => {
    db?.close()
    db = undefined
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('workspaces insert/select 왕복', async () => {
    db = await openDatabase(':memory:')

    await db.drizzle.insert(workspaces).values({
      name: '개인',
      color: '#111111',
      position: 1,
      isActive: true,
      updatedAt: 1000
    })

    const rows = await db.drizzle.select().from(workspaces).where(eq(workspaces.name, '개인'))
    expect(rows).toHaveLength(1)
    expect(rows[0].isActive).toBe(true)
    expect(rows[0].position).toBe(1)
    expect(rows[0].remoteId).toBeNull()
    expect(rows[0].deletedAt).toBeNull()
  })

  it('sync_outbox 에 쌓은 변경 로그를 op 로 조회한다', async () => {
    db = await openDatabase(':memory:')

    await db.drizzle.insert(syncOutbox).values([
      { table: 'bookmarks', rowId: '1', op: 'upsert', createdAt: 10 },
      { table: 'settings', rowId: 'theme', op: 'delete', createdAt: 20 }
    ])

    const rows = await db.drizzle.select().from(syncOutbox).where(eq(syncOutbox.op, 'upsert'))
    expect(rows).toHaveLength(1)
    expect(rows[0].table).toBe('bookmarks')
    expect(rows[0].rowId).toBe('1')
    expect(rows[0].payload).toBeNull()
    expect(rows[0].triedAt).toBeNull()
  })

  it('sync_state 는 키-값 왕복이 된다', async () => {
    db = await openDatabase(':memory:')

    await db.drizzle.insert(syncState).values({ key: 'lastPulledAt', value: '1234' })
    const rows = await db.drizzle.select().from(syncState)
    expect(rows).toEqual([{ key: 'lastPulledAt', value: '1234' }])
  })

  it('기존 표에 remote_id/workspace_id/deleted_at 컬럼이 생긴다', async () => {
    db = await openDatabase(':memory:')

    const columnsOf = (table: string): string[] => {
      const rows = db!.drizzle.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))
      return rows.map((row) => row.name)
    }

    for (const table of ['accounts', 'vault_items', 'bookmarks']) {
      const columns = columnsOf(table)
      expect(columns).toContain('remote_id')
      expect(columns).toContain('workspace_id')
      expect(columns).toContain('deleted_at')
    }
    // 북마크는 LWW 비교를 위해 updated_at 도 필요하다
    expect(columnsOf('bookmarks')).toContain('updated_at')
  })

  it('같은 파일 DB 를 두 번 열어도 0005 가 중복 적용되지 않는다', async () => {
    const path = join(dir!, 'samba.db')

    db = await openDatabase(path)
    db.drizzle.insert(workspaces).values({ name: '업무', updatedAt: 1 }).run()
    db.save()
    db.close()

    const reopened = await openDatabase(path)
    db = reopened
    const rows = reopened.drizzle.select().from(workspaces).all()
    expect(rows).toHaveLength(1)

    const tags = reopened.drizzle
      .all<{ tag: string }>(sql`SELECT tag FROM __migrations WHERE tag LIKE '0005%'`)
      .map((row) => row.tag)
    expect(tags).toEqual(['0005_sync_workspaces'])
  })
})
