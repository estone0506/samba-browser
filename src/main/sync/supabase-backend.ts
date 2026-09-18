// SyncBackend 의 supabase-js 구현. 앱은 anon 키 + 사용자 JWT 로만 접근한다
// (서비스 롤 키는 어디에도 두지 않는다)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AuthExpiredError, type RemoteKeyedRow, type RemoteRow, type SyncBackend } from './backend'
import type { SessionStorageAdapter } from './session-store'
import { readSupabaseEnv } from './env'

// 인증 만료로 볼 응답 코드/문구
const AUTH_EXPIRED = ['PGRST301', '401', 'jwt expired', 'invalid refresh token']

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
    async currentUser() {
      const { data } = await client.auth.getUser()
      return data.user ? { userId: data.user.id, email: data.user.email ?? '' } : null
    },
    async select(table, sinceMs) {
      const { data, error } = await client
        .from(table)
        .select('*')
        .gt('updated_at', new Date(sinceMs).toISOString())
        .order('updated_at', { ascending: true })
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
    async selectKeyed(table, sinceMs) {
      const { data, error } = await client
        .from(table)
        .select('*')
        .gt('updated_at', new Date(sinceMs).toISOString())
        .order('updated_at', { ascending: true })
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
