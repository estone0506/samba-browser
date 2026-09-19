// 동기화 충돌 해결 규칙 — 순수 함수라 DB·네트워크 없이 값만 검증한다

import { describe, it, expect } from 'vitest'
import {
  TOMBSTONE_TTL_DAYS,
  TOMBSTONE_TTL_MS,
  decideLww,
  bookmarkKey,
  mergeBookmarks,
  expiredTombstones,
  type BookmarkLike,
  type Syncable
} from '../src/main/sync/merge'

function syncable(updatedAt: number, deletedAt: number | null = null): Syncable {
  return { remoteId: `r-${updatedAt}`, updatedAt, deletedAt }
}

function bookmark(partial: Partial<BookmarkLike> & { url: string }): BookmarkLike {
  return {
    remoteId: partial.remoteId ?? `r-${partial.url}`,
    updatedAt: partial.updatedAt ?? 0,
    deletedAt: partial.deletedAt ?? null,
    folderPath: partial.folderPath ?? '북마크바',
    url: partial.url,
    title: partial.title ?? '제목',
    position: partial.position ?? 0
  }
}

describe('decideLww', () => {
  it('한쪽만 있으면 그쪽이 이긴다', () => {
    expect(decideLww(null, syncable(10))).toBe('remote')
    expect(decideLww(syncable(10), null)).toBe('local')
    expect(decideLww(null, null)).toBe('equal')
  })

  it('updatedAt 이 큰 쪽이 이기고, 같으면 equal', () => {
    expect(decideLww(syncable(10), syncable(20))).toBe('remote')
    expect(decideLww(syncable(30), syncable(20))).toBe('local')
    expect(decideLww(syncable(20), syncable(20))).toBe('equal')
  })

  it('삭제(tombstone)도 하나의 수정으로 보고 같은 규칙을 따른다', () => {
    // 원격 삭제가 더 최신이면 삭제가 이긴다
    expect(decideLww(syncable(10), syncable(20, 20))).toBe('remote')
    // 로컬 수정이 삭제보다 나중이면 살아난다
    expect(decideLww(syncable(30), syncable(20, 20))).toBe('local')
  })
})

describe('bookmarkKey', () => {
  it('폴더 경로의 앞뒤 슬래시와 URL 의 대소문자·트레일링 슬래시를 정규화한다', () => {
    const a = bookmarkKey({ folderPath: '북마크바/개발', url: 'https://Example.com/' })
    const b = bookmarkKey({ folderPath: '/북마크바/개발/', url: 'https://example.com' })
    expect(a).toBe(b)
  })

  it('폴더나 URL 이 다르면 다른 키가 된다', () => {
    const base = bookmarkKey({ folderPath: '북마크바', url: 'https://example.com/a' })
    expect(bookmarkKey({ folderPath: '북마크바/개발', url: 'https://example.com/a' })).not.toBe(
      base
    )
    expect(bookmarkKey({ folderPath: '북마크바', url: 'https://example.com/b' })).not.toBe(base)
  })
})

describe('mergeBookmarks', () => {
  it('한쪽에만 있는 북마크는 둘 다 남는다(합집합)', () => {
    const local = [bookmark({ url: 'https://a.example', updatedAt: 1 })]
    const remote = [bookmark({ url: 'https://b.example', updatedAt: 1 })]
    const merged = mergeBookmarks(local, remote)
    expect(merged).toHaveLength(2)
    expect(merged.map((b) => b.url).sort()).toEqual(['https://a.example', 'https://b.example'])
  })

  it('같은 키는 하나만 남고 updatedAt 이 큰 쪽의 제목·순서를 쓴다', () => {
    const local = [
      bookmark({ url: 'https://example.com/', updatedAt: 10, title: '옛 제목', position: 1 })
    ]
    const remote = [
      bookmark({ url: 'https://Example.com', updatedAt: 20, title: '새 제목', position: 5 })
    ]
    const merged = mergeBookmarks(local, remote)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBe('새 제목')
    expect(merged[0].position).toBe(5)
  })

  it('한쪽이 tombstone 이고 그게 더 최신이면 결과도 tombstone 이다', () => {
    const local = [bookmark({ url: 'https://example.com/a', updatedAt: 10 })]
    const remote = [bookmark({ url: 'https://example.com/a', updatedAt: 20, deletedAt: 20 })]
    const merged = mergeBookmarks(local, remote)
    expect(merged).toHaveLength(1)
    expect(merged[0].deletedAt).toBe(20)
  })

  it('삭제보다 나중에 살린 쪽이 최신이면 살아 있는 행이 남는다', () => {
    const local = [bookmark({ url: 'https://example.com/a', updatedAt: 30 })]
    const remote = [bookmark({ url: 'https://example.com/a', updatedAt: 20, deletedAt: 20 })]
    const merged = mergeBookmarks(local, remote)
    expect(merged).toHaveLength(1)
    expect(merged[0].deletedAt).toBeNull()
  })
})

describe('expiredTombstones', () => {
  const now = 1_000_000_000_000

  it('30일이 지난 tombstone 만 돌려준다', () => {
    const rows = [
      { ...syncable(1), remoteId: '오래된', deletedAt: now - TOMBSTONE_TTL_MS },
      { ...syncable(2), remoteId: '아슬아슬', deletedAt: now - (TOMBSTONE_TTL_MS - 60_000) },
      { ...syncable(3), remoteId: '살아있음', deletedAt: null }
    ]
    const expired = expiredTombstones(rows, now)
    expect(expired.map((r) => r.remoteId)).toEqual(['오래된'])
  })

  it('29일 59분은 포함되지 않는다', () => {
    const almost = now - (29 * 24 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(expiredTombstones([{ ...syncable(1), deletedAt: almost }], now)).toHaveLength(0)
  })

  it('TTL 상수는 30일이다', () => {
    expect(TOMBSTONE_TTL_DAYS).toBe(30)
    expect(TOMBSTONE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
