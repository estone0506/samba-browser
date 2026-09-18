// 동기화 충돌 해결 규칙 — 순수 함수만 둔다(DB·네트워크 의존 없음).
// 설정·계정·금고 = LWW(updatedAt 큰 쪽), 북마크 = 합집합, 삭제 = tombstone 30일

export const TOMBSTONE_TTL_DAYS = 30
export const TOMBSTONE_TTL_MS = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000

export interface Syncable {
  remoteId: string
  updatedAt: number
  deletedAt: number | null
}

export type MergeDecision = 'local' | 'remote' | 'equal'

/** 마지막 수정 시각이 큰 쪽이 이긴다. 삭제도 하나의 수정으로 본다 */
export function decideLww(local: Syncable | null, remote: Syncable | null): MergeDecision {
  if (!local && !remote) return 'equal'
  if (!local) return 'remote'
  if (!remote) return 'local'
  if (remote.updatedAt > local.updatedAt) return 'remote'
  if (local.updatedAt > remote.updatedAt) return 'local'
  return 'equal'
}

export interface BookmarkLike extends Syncable {
  folderPath: string
  url: string
  title: string
  position: number
}

function normalizePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.trim().length > 0)
    .join('/')
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`
  } catch {
    // URL 로 못 읽는 값(사용자가 손으로 넣은 주소 등)은 문자열 수준에서만 정규화한다
    return url.trim().toLowerCase().replace(/\/+$/, '')
  }
}

/** 합집합 판정의 동일성 키 — 같은 폴더의 같은 URL 은 한 개다 */
export function bookmarkKey(b: Pick<BookmarkLike, 'folderPath' | 'url'>): string {
  return `${normalizePath(b.folderPath)}\n${normalizeUrl(b.url)}`
}

/** 북마크는 합집합. 같은 키가 겹치면 updatedAt 이 큰 쪽 한 개만 남긴다 */
export function mergeBookmarks(local: BookmarkLike[], remote: BookmarkLike[]): BookmarkLike[] {
  const byKey = new Map<string, BookmarkLike>()
  for (const row of [...local, ...remote]) {
    const key = bookmarkKey(row)
    const prev = byKey.get(key)
    if (!prev || row.updatedAt > prev.updatedAt) byKey.set(key, row)
  }
  return [...byKey.values()]
}

/** 30일이 지난 tombstone — 호출부가 이 행들만 물리 삭제한다 */
export function expiredTombstones<T extends Syncable>(rows: T[], now: number): T[] {
  return rows.filter((r) => r.deletedAt !== null && now - r.deletedAt >= TOMBSTONE_TTL_MS)
}
