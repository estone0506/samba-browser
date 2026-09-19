// 풀 커서가 PostgREST 필터 문자열로 어떻게 나가는지 문자열 단위로 못 박는다.
//
// 3차 리뷰 C3 회귀: ISO 타임스탬프를 인용하지 않고 `.or()` 에 넣으면 PostgREST 가
// 값 안의 `:`·`+` 를 필터 문법으로 읽어 조건이 통째로 깨진다(= 전체 행을 다시 받거나
// 아무것도 못 받는다).
// 3차 리뷰 M4 회귀: 로컬 커서는 ms, 서버 timestamptz 는 µs 라 서버 조건은 `>=` 로 넓게
// 걸고, 정확한 통과 판정은 받은 뒤 (ts, id) 로 한다

import { describe, it, expect } from 'vitest'
import { cursorFilter } from '../src/main/sync/supabase-backend'
import { isAfterCursor, isAtOrAfterCursor } from '../src/main/sync/backend'

describe('cursorFilter — PostgREST 필터 문자열', () => {
  it('타임스탬프를 큰따옴표로 감싼다', () => {
    const iso = new Date(1_700_000_000_123).toISOString()
    const filter = cursorFilter({ ts: 1_700_000_000_123, id: 'row-1' }, 'id')
    expect(filter).toContain(`updated_at.gt."${iso}"`)
    // 인용하지 않은 형태는 남아 있으면 안 된다
    expect(filter).not.toContain(`updated_at.gt.${iso},`)
  })

  it('id 도 큰따옴표로 감싸고, 동률 구간은 >= 로 넓게 건다', () => {
    const iso = new Date(1_700_000_000_123).toISOString()
    const filter = cursorFilter({ ts: 1_700_000_000_123, id: 'row-1' }, 'id')
    expect(filter).toBe(
      `updated_at.gt."${iso}",and(updated_at.gte."${iso}",id.gt."row-1")`
    )
  })

  it('복합 PK 표는 동률 판정 컬럼이 key 다', () => {
    const iso = new Date(500).toISOString()
    expect(cursorFilter({ ts: 500, id: 'searchEngine' }, 'key')).toBe(
      `updated_at.gt."${iso}",and(updated_at.gte."${iso}",key.gt."searchEngine")`
    )
  })

  it('id 가 없는 옛 커서는 시각만 보되 >= 로 넓게 건다', () => {
    const iso = new Date(500).toISOString()
    expect(cursorFilter({ ts: 500, id: null }, 'id')).toBe(`updated_at.gte."${iso}"`)
  })

  it('따옴표·역슬래시가 섞인 id 도 이스케이프한다', () => {
    const filter = cursorFilter({ ts: 0, id: 'a"b\\c' }, 'id')
    expect(filter).toContain('id.gt."a\\"b\\\\c"')
  })
})

describe('커서 판정 — 넓게 받고 정확히 거른다(M4)', () => {
  const cursor = { ts: 1000, id: 'b' }

  it('넓은 조건은 커서 시각을 포함한다', () => {
    expect(isAtOrAfterCursor(1000, cursor)).toBe(true)
    expect(isAtOrAfterCursor(999, cursor)).toBe(false)
    expect(isAtOrAfterCursor(1001, cursor)).toBe(true)
  })

  it('정확한 조건은 같은 시각에서 id 로 가른다', () => {
    expect(isAfterCursor(1000, 'a', cursor)).toBe(false)
    expect(isAfterCursor(1000, 'b', cursor)).toBe(false)
    expect(isAfterCursor(1000, 'c', cursor)).toBe(true)
    expect(isAfterCursor(1001, 'a', cursor)).toBe(true)
  })

  it('넓은 조건은 정확한 조건의 상위집합이다(놓치는 행이 없다)', () => {
    for (const ts of [998, 999, 1000, 1001]) {
      for (const id of ['a', 'b', 'c']) {
        if (isAfterCursor(ts, id, cursor)) expect(isAtOrAfterCursor(ts, cursor)).toBe(true)
      }
    }
  })
})
