// 계정 디렉터리 — "로그인 먼저, 설정은 계정에 따라온다".
//
// 앱에 내장된 중앙 Supabase(디렉터리)에 계정을 만들고, 그 계정 행에 **자기 데이터 Supabase 의
// 주소(URL·anon 키)** 두 줄만 둔다. 주문·금고·북마크 같은 실제 데이터는 그 주소의 프로젝트로 간다.
// 어느 PC 에서든 같은 계정으로 로그인하면 주소를 내려받아 자동으로 붙는다.
//
// 저장 위치는 새 표가 아니라 기존 settings_sync 표(RLS: user_id = auth.uid())의 고정 작업공간
// 한 칸이다 — 디렉터리 프로젝트에 schema.sql 을 그대로 적용하면 되고, 남의 행은 못 본다.
// anon 키는 공개용 키라 여기 두어도 되지만 service_role 키는 형식 검사로 거른다(shared/sync)

import { isSupabaseAnonKey, isSupabaseProjectUrl } from '../../shared/sync'
import type { RemoteKeyedRow, SyncBackend } from './backend'

/** 디렉터리 행이 쓰는 고정 작업공간 id(실제 작업공간과 겹치지 않는 nil uuid) */
export const DIRECTORY_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000'
export const DIRECTORY_URL_KEY = 'directory.supabaseUrl'
export const DIRECTORY_ANON_KEY = 'directory.supabaseAnonKey'

export interface DirectoryConfig {
  url: string
  anonKey: string
}

/** 계정에 저장된 데이터 Supabase 주소. 없거나 형식이 틀리면 null */
export async function readDirectoryConfig(
  backend: SyncBackend,
  userId: string
): Promise<DirectoryConfig | null> {
  const rows = await backend.selectKeyed(
    'settings_sync',
    { ts: 0, id: null },
    DIRECTORY_WORKSPACE_ID
  )
  const mine = rows.filter((r) => r.user_id === userId && r.deleted_at == null)
  const valueOf = (key: string): string => {
    const row = mine.find((r) => r.key === key)
    return row && typeof row.value === 'string' ? row.value.trim() : ''
  }
  const url = valueOf(DIRECTORY_URL_KEY)
  const anonKey = valueOf(DIRECTORY_ANON_KEY)
  if (!isSupabaseProjectUrl(url) || !isSupabaseAnonKey(anonKey)) return null
  return { url, anonKey }
}

/** 계정 행에 데이터 Supabase 주소를 쓴다(덮어쓰기). 형식이 틀리면 던진다 */
export async function writeDirectoryConfig(
  backend: SyncBackend,
  userId: string,
  config: DirectoryConfig,
  now: number = Date.now()
): Promise<void> {
  if (!isSupabaseProjectUrl(config.url)) throw new Error('bad-url')
  if (!isSupabaseAnonKey(config.anonKey)) throw new Error('bad-key')
  const iso = new Date(now).toISOString()
  const row = (key: string, value: string): RemoteKeyedRow => ({
    user_id: userId,
    workspace_id: DIRECTORY_WORKSPACE_ID,
    key,
    value,
    updated_at: iso,
    deleted_at: null
  })
  await backend.upsertKeyed('settings_sync', [
    row(DIRECTORY_URL_KEY, config.url.trim()),
    row(DIRECTORY_ANON_KEY, config.anonKey.trim())
  ])
}
