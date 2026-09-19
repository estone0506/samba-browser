// SyncBackend 의 supabase-js 구현. 앱은 anon 키 + 사용자 JWT 로만 접근한다
// (서비스 롤 키는 어디에도 두지 않는다)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  AuthExpiredError,
  DEFAULT_SELECT_LIMIT,
  toPullCursor,
  type PullCursor,
  type RemoteKeyedRow,
  type RemoteRow,
  type SyncBackend
} from './backend'
import type { SessionStorageAdapter } from './session-store'
import { readSupabaseEnv } from './env'

// 인증 만료로 볼 응답 코드/문구
const AUTH_EXPIRED = ['PGRST301', '401', 'jwt expired', 'invalid refresh token']

/** PostgREST 의 or 필터 값에 그대로 넣을 수 있게 감싼다(쉼표·괄호가 섞여도 안전하다) */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 키셋 조건. updated_at 만 보면 같은 시각을 가진 행이 페이지 경계를 넘을 때 나머지를 잃는다.
 * id 가 null 인 커서(옛 숫자 커서)는 동률 판정 없이 예전 그대로 gt 만 건다.
 *
 * 필터 빌더 타입을 직접 들고 오지 않으려고 필요한 메서드만 구조로 요구한다
 */
function whereAfterCursor<Q extends { gt(c: string, v: string): Q; or(filter: string): Q }>(
  query: Q,
  cursor: PullCursor,
  idColumn: string
): Q {
  const iso = new Date(cursor.ts).toISOString()
  if (cursor.id === null) return query.gt('updated_at', iso)
  return query.or(
    `updated_at.gt.${iso},and(updated_at.eq.${iso},${idColumn}.gt.${quote(cursor.id)})`
  )
}

function raise(message: string): never {
  const m = message.toLowerCase()
  if (AUTH_EXPIRED.some((p) => m.includes(p.toLowerCase()))) throw new AuthExpiredError(message)
  throw new Error(message)
}

export function createSupabaseBackend(storage: SessionStorageAdapter): SyncBackend {
  const env = readSupabaseEnv()
  const client: SupabaseClient = createClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 데스크톱 앱은 URL 해시가 없다. 코드 교환은 우리가 직접 한다
      detectSessionInUrl: false,
      flowType: 'pkce',
      storage
    }
  })

  const identity = (
    user: { id: string; email?: string } | null
  ): { userId: string; email: string } => {
    if (!user) raise('사용자 정보를 받지 못했습니다')
    return { userId: user.id, email: user.email ?? '' }
  }

  return {
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async oauthUrl(redirectTo) {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true }
      })
      if (error) raise(error.message)
      if (!data.url) raise('구글 로그인 주소를 받지 못했습니다')
      return data.url
    },
    async exchangeCode(code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code)
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signOut() {
      await client.auth.signOut()
    },
    async clearLocalSession() {
      // scope: 'local' 은 서버 세션은 두고 이 클라이언트 저장소만 비운다
      await client.auth.signOut({ scope: 'local' })
    },
    async currentUser() {
      const { data } = await client.auth.getUser()
      return data.user ? { userId: data.user.id, email: data.user.email ?? '' } : null
    },
    async select(table, cursor, workspaceId, limit) {
      let query = whereAfterCursor(client.from(table).select('*'), toPullCursor(cursor), 'id')
      // 활성 작업공간의 행만 받는다(다른 작업공간 행은 로컬에서 보이지도 않는다)
      if (workspaceId !== undefined) query = query.eq('workspace_id', workspaceId)
      const { data, error } = await query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit ?? DEFAULT_SELECT_LIMIT)
      if (error) raise(error.message)
      return (data ?? []) as RemoteRow[]
    },
    async selectAll(table) {
      const { data, error } = await client.from(table).select('*')
      if (error) raise(error.message)
      return (data ?? []) as RemoteRow[]
    },
    async upsert(table, rows) {
      if (rows.length === 0) return
      const { error } = await client.from(table).upsert(rows)
      if (error) raise(error.message)
    },
    async selectKeyed(table, cursor, workspaceId, limit) {
      // 복합 PK 라 id 컬럼이 없다 — 동률 판정·정렬을 key 로 한다
      let query = whereAfterCursor(client.from(table).select('*'), toPullCursor(cursor), 'key')
      if (workspaceId !== undefined) query = query.eq('workspace_id', workspaceId)
      const { data, error } = await query
        .order('updated_at', { ascending: true })
        .order('key', { ascending: true })
        .limit(limit ?? DEFAULT_SELECT_LIMIT)
      if (error) raise(error.message)
      return (data ?? []) as RemoteKeyedRow[]
    },
    async upsertKeyed(table, rows) {
      if (rows.length === 0) return
      // PostgREST 는 표의 기본키로 충돌을 해결한다 — settings_sync 는 (user_id, workspace_id, key)
      const { error } = await client.from(table).upsert(rows)
      if (error) raise(error.message)
    },
    async remove(table, ids) {
      if (ids.length === 0) return
      const { error } = await client.from(table).delete().in('id', ids)
      if (error) raise(error.message)
    },
    async subscribe(table, onChange) {
      // Realtime 은 "있으면 좋은" 기능이다. 실패해도 폴링으로 계속 동작해야 한다
      try {
        const channel = client
          .channel(`samba-${table}`)
          .on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange())
          .subscribe()
        return () => {
          void client.removeChannel(channel)
        }
      } catch (e: unknown) {
        console.warn(
          'Realtime 구독 실패(폴링으로 계속)',
          e instanceof Error ? e.message : String(e)
        )
        return () => {}
      }
    }
  }
}
