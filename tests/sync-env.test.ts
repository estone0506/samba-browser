// Supabase 접속 정보(.env) 읽기 검증. 네트워크는 쓰지 않는다
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readSupabaseEnv, hasSupabaseEnv } from '../src/main/sync/env'

const URL_KEY = 'SAMBA_SUPABASE_URL'
const ANON_KEY = 'SAMBA_SUPABASE_ANON_KEY'

describe('sync/env', () => {
  // 테스트 사이에 환경 변수가 새지 않도록 원래 값을 복원한다
  let savedUrl: string | undefined
  let savedAnon: string | undefined

  beforeEach(() => {
    savedUrl = process.env[URL_KEY]
    savedAnon = process.env[ANON_KEY]
    delete process.env[URL_KEY]
    delete process.env[ANON_KEY]
  })

  afterEach(() => {
    if (savedUrl === undefined) delete process.env[URL_KEY]
    else process.env[URL_KEY] = savedUrl
    if (savedAnon === undefined) delete process.env[ANON_KEY]
    else process.env[ANON_KEY] = savedAnon
  })

  it('process.env 에 값이 있으면 그대로 읽는다', () => {
    process.env[URL_KEY] = 'https://abcdefghijkl.supabase.co'
    process.env[ANON_KEY] = 'eyJhbGciOiJIUzI1NiJ9.test'
    expect(readSupabaseEnv()).toEqual({
      url: 'https://abcdefghijkl.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiJ9.test'
    })
  })

  it('앞뒤 공백은 잘라낸다', () => {
    process.env[URL_KEY] = '  https://abcdefghijkl.supabase.co \n'
    process.env[ANON_KEY] = ' eyJhbGciOiJIUzI1NiJ9.test '
    const env = readSupabaseEnv()
    expect(env.url).toBe('https://abcdefghijkl.supabase.co')
    expect(env.anonKey).toBe('eyJhbGciOiJIUzI1NiJ9.test')
  })

  it('값이 없으면 빈 문자열이고 hasSupabaseEnv 는 false 다', () => {
    expect(readSupabaseEnv()).toEqual({ url: '', anonKey: '' })
    expect(hasSupabaseEnv()).toBe(false)
  })

  it('두 값이 모두 있으면 hasSupabaseEnv 는 true 다', () => {
    process.env[URL_KEY] = 'https://abcdefghijkl.supabase.co'
    process.env[ANON_KEY] = 'eyJhbGciOiJIUzI1NiJ9.test'
    expect(hasSupabaseEnv()).toBe(true)
  })

  it('url 이 https 가 아니면 hasSupabaseEnv 는 false 다', () => {
    process.env[URL_KEY] = 'http://abcdefghijkl.supabase.co'
    process.env[ANON_KEY] = 'eyJhbGciOiJIUzI1NiJ9.test'
    expect(hasSupabaseEnv()).toBe(false)
  })

  it('anon 키만 비어도 hasSupabaseEnv 는 false 다', () => {
    process.env[URL_KEY] = 'https://abcdefghijkl.supabase.co'
    expect(hasSupabaseEnv()).toBe(false)
  })
})
