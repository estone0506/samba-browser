// Supabase 접속 정보 읽기.
// 우선순위: 앱 설정(설정 → 계정에서 사용자가 붙여넣은 값) → .env / 빌드 주입 값 → 없음.
// 어느 쪽에도 값이 없으면 동기화를 끄고 로컬 전용으로 돈다.
// 서비스 롤 키는 읽지 않는다 — 앱에는 publishable(anon) 키만 들어간다

export interface SupabaseEnv {
  url: string
  anonKey: string
}

const URL_KEY = 'SAMBA_SUPABASE_URL'
const ANON_KEY = 'SAMBA_SUPABASE_ANON_KEY'

// 앱 설정에서 읽어 온 값. 메인 프로세스가 시작할 때 한 번 심는다
let fromSettings: SupabaseEnv = { url: '', anonKey: '' }

/** 설정 파일의 값을 env 읽기보다 앞에 놓는다(빈 문자열이면 없는 것으로 본다) */
export function setSupabaseEnvFromSettings(url: string, anonKey: string): void {
  fromSettings = { url: url.trim(), anonKey: anonKey.trim() }
}

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
  return {
    url: fromSettings.url || readEnv(URL_KEY).trim(),
    anonKey: fromSettings.anonKey || readEnv(ANON_KEY).trim()
  }
}

/** 두 값이 모두 있어야 동기화 기능을 켤 수 있다 */
export function hasSupabaseEnv(): boolean {
  const e = readSupabaseEnv()
  return e.url.startsWith('https://') && e.anonKey.length > 0
}
