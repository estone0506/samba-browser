// Supabase 접속 정보 읽기. 개발(process.env)·빌드(import.meta.env) 양쪽을 지원한다.
// 서비스 롤 키는 읽지 않는다 — 앱에는 anon 키만 들어간다

export interface SupabaseEnv {
  url: string
  anonKey: string
}

const URL_KEY = 'SAMBA_SUPABASE_URL'
const ANON_KEY = 'SAMBA_SUPABASE_ANON_KEY'

function readEnv(key: string): string {
  const fromProcess = process.env[key]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess
  // electron-vite 는 envPrefix 에 맞는 값을 import.meta.env 로 주입한다
  // ImportMetaEnv 는 인덱스 시그니처가 없어 unknown 을 거쳐 좁힌다
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = meta?.[key]
  return typeof fromMeta === 'string' ? fromMeta : ''
}

export function readSupabaseEnv(): SupabaseEnv {
  return { url: readEnv(URL_KEY).trim(), anonKey: readEnv(ANON_KEY).trim() }
}

/** 두 값이 모두 있어야 동기화 기능을 켤 수 있다 */
export function hasSupabaseEnv(): boolean {
  const e = readSupabaseEnv()
  return e.url.startsWith('https://') && e.anonKey.length > 0
}
