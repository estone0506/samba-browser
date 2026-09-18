// 메모리 테이블 기반 가짜 SyncBackend. 이후 모든 sync 테스트는 이것만 쓴다(네트워크 없음)
import { AuthExpiredError, type RemoteRow, type SyncBackend } from '../../src/main/sync/backend'

export interface FakeBackend extends SyncBackend {
  /** 테이블 내용을 직접 들여다본다(단언용) */
  rows(table: string): RemoteRow[]
  /** 서버에 미리 행을 심는다(풀 테스트용) */
  seed(table: string, rows: RemoteRow[]): void
  /** subscribe 로 등록한 콜백을 수동으로 발화한다 */
  fire(table: string): void
  /** 다음 호출부터 인증 만료로 실패시킨다(기기 원격 로그아웃 재현) */
  expireAuth(): void
  /** 호출 횟수 기록 */
  readonly calls: { select: number; upsert: number; remove: number }
}

export const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001'

function updatedAtMs(row: RemoteRow): number {
  const v = row.updated_at
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

export function createFakeBackend(): FakeBackend {
  const tables = new Map<string, Map<string, RemoteRow>>()
  const listeners = new Map<string, Set<() => void>>()
  const calls = { select: 0, upsert: 0, remove: 0 }
  let signedIn: { userId: string; email: string } | null = null
  let authExpired = false

  const table = (name: string): Map<string, RemoteRow> => {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }

  const guard = (): void => {
    if (authExpired) throw new AuthExpiredError('JWT expired')
  }

  return {
    async signUp(email) {
      signedIn = { userId: FAKE_USER_ID, email }
      return signedIn
    },
    async signIn(email) {
      signedIn = { userId: FAKE_USER_ID, email }
      return signedIn
    },
    async oauthUrl(redirectTo) {
      return `https://fake.supabase.co/auth/v1/authorize?redirect_to=${encodeURIComponent(redirectTo)}`
    },
    async exchangeCode(code) {
      if (!code) throw new Error('인증 코드가 없습니다')
      signedIn = { userId: FAKE_USER_ID, email: 'fake@example.com' }
      return signedIn
    },
    async signOut() {
      signedIn = null
    },
    async currentUser() {
      return signedIn
    },
    async select(name, sinceMs) {
      guard()
      calls.select += 1
      return [...table(name).values()]
        .filter((r) => updatedAtMs(r) > sinceMs)
        .sort((a, b) => updatedAtMs(a) - updatedAtMs(b))
        .map((r) => ({ ...r }))
    },
    async upsert(name, rows) {
      guard()
      calls.upsert += 1
      const t = table(name)
      // id 기준으로 통째로 덮어쓴다
      for (const row of rows) t.set(row.id, { ...row })
    },
    async remove(name, ids) {
      guard()
      calls.remove += 1
      const t = table(name)
      for (const id of ids) t.delete(id)
    },
    async subscribe(name, onChange) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(onChange)
      return () => {
        set!.delete(onChange)
      }
    },
    rows(name) {
      return [...table(name).values()].map((r) => ({ ...r }))
    },
    seed(name, rows) {
      const t = table(name)
      for (const row of rows) t.set(row.id, { ...row })
    },
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn()
    },
    expireAuth() {
      authExpired = true
    },
    calls
  }
}
