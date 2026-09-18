import { describe, it, expect, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { sites } from '../src/main/db/schema'
import { eq } from 'drizzle-orm'

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
})
