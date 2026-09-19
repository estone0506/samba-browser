import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as SqlJsDatabase } from 'sql.js'
import { openDatabase, type Db } from '../src/main/db/client'
import { migrations } from '../src/main/db/migrations'
import { runMigrations } from '../src/main/db/migrate'
import { bookmarks, sites, workspaces, syncOutbox, syncState } from '../src/main/db/schema'
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

  it('remote_id 에 UNIQUE 인덱스가 걸린다(NULL 은 여러 개 허용)', async () => {
    db = await openDatabase(':memory:')

    const indexesOf = (table: string): string[] => {
      const rows = db!.drizzle.all<{ name: string }>(sql.raw(`PRAGMA index_list(${table})`))
      return rows.map((row) => row.name)
    }
    for (const table of ['accounts', 'vault_items', 'bookmarks']) {
      expect(indexesOf(table)).toContain(`${table}_remote_id_unique`)
    }

    const insert = (remoteId: string | null): void => {
      db!.drizzle
        .insert(bookmarks)
        .values({ folderId: null, title: 't', url: `https://e${Math.random()}`, remoteId })
        .run()
    }
    // 아직 올리지 않은 행(NULL)은 여러 개 공존한다
    insert(null)
    insert(null)
    insert('remote-1')
    expect(() => insert('remote-1')).toThrow()
  })

  it('변경 로그에 workspace_id 컬럼이 생긴다(0007)', async () => {
    db = await openDatabase(':memory:')
    const rows = db.drizzle.all<{ name: string }>(sql.raw('PRAGMA table_info(sync_outbox)'))
    expect(rows.map((r) => r.name)).toContain('workspace_id')
  })

  it('remote_id 가 중복돼 있어도 0006 이 정리하고 넘어간다', async () => {
    // New-I1 — 인덱스가 없던 동안 중복이 생긴 DB 에 그대로 UNIQUE 를 걸면 앱이 못 뜬다
    db = await openDatabase(':memory:')
    const run = (statement: string): void => {
      db!.drizzle.run(sql.raw(statement))
    }
    // 0006 이 적용되기 전(0005) 상태로 되돌린다
    for (const table of ['accounts', 'vault_items', 'bookmarks']) {
      run(`DROP INDEX IF EXISTS ${table}_remote_id_unique`)
    }
    db.drizzle
      .insert(bookmarks)
      .values([
        { folderId: null, title: 'a', url: 'https://a.example', remoteId: 'dup' },
        { folderId: null, title: 'b', url: 'https://b.example', remoteId: 'dup' },
        { folderId: null, title: 'c', url: 'https://c.example', remoteId: null }
      ])
      .run()

    const sql0006 = migrations.find((m) => m.tag === '0006_remote_id_unique')
    expect(sql0006).toBeDefined()
    expect(sql0006?.optional).toBe(true)
    expect(() => {
      for (const statement of sql0006!.sql) run(statement)
    }).not.toThrow()

    // 가장 먼저 만들어진 행만 remote_id 를 지키고, 뒤의 중복은 비워져 다음 푸시에서 새로 받는다
    const rows = db.drizzle.select().from(bookmarks).all()
    expect(rows.filter((r) => r.remoteId === 'dup').map((r) => r.title)).toEqual(['a'])
    expect(rows.filter((r) => r.remoteId === null)).toHaveLength(2)
  })

  it('선택 마이그레이션이 실패해도 기동을 막지 않는다', () => {
    // 실패한 태그는 기록하지 않아 다음 기동에 다시 시도한다
    const applied: string[] = []
    const stub = {
      run: (statement: string, params?: unknown[]) => {
        if (statement.includes('accounts_remote_id_unique')) throw new Error('constraint failed')
        if (statement.startsWith('INSERT INTO __migrations') && params)
          applied.push(String(params[0]))
      },
      exec: () => [{ columns: ['tag'], values: applied.map((tag) => [tag]) }]
    } as unknown as SqlJsDatabase

    expect(() => runMigrations(stub)).not.toThrow()
    expect(applied).not.toContain('0006_remote_id_unique')
    // 그 뒤의 마이그레이션은 계속 적용된다
    expect(applied).toContain('0007_outbox_workspace')
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
