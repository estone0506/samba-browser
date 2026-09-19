// 설정 → 계정의 "Supabase 연결" 입력값 검증과 설정 저장 규칙.
// 실제 키는 쓰지 않고 형식만 본다
import { describe, it, expect } from 'vitest'
import { isSupabaseProjectUrl, isSupabaseAnonKey, maskSupabaseKey } from '../src/shared/sync'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'
import { parseSettings, DEFAULT_SETTINGS } from '../src/shared/settings'

describe('Supabase 연결 입력값 검증', () => {
  it('https 프로젝트 URL 만 받는다', () => {
    expect(isSupabaseProjectUrl('https://abcdefghijkl.supabase.co')).toBe(true)
    expect(isSupabaseProjectUrl('  https://abcdefghijkl.supabase.co  ')).toBe(true)
    expect(isSupabaseProjectUrl('http://abcdefghijkl.supabase.co')).toBe(false)
    expect(isSupabaseProjectUrl('abcdefghijkl.supabase.co')).toBe(false)
    expect(isSupabaseProjectUrl('')).toBe(false)
  })

  it('publishable·JWT anon 키는 받고 비밀 키는 거부한다', () => {
    expect(isSupabaseAnonKey('sb_publishable_abcdefghijklmnop')).toBe(true)
    expect(isSupabaseAnonKey('eyJ.dummy-anon-key-0123456789')).toBe(true)
    expect(isSupabaseAnonKey('sb_secret_abcdefghijklmnop')).toBe(false)
    expect(isSupabaseAnonKey('eyJ.service_role.dummy-0123456789')).toBe(false)
    expect(isSupabaseAnonKey('short')).toBe(false)
    expect(isSupabaseAnonKey('')).toBe(false)
  })

  it('키는 앞뒤만 남기고 마스킹한다', () => {
    expect(maskSupabaseKey('sb_publishable_abcdefghijklmnop')).toBe('sb_publishab…mnop')
    expect(maskSupabaseKey('')).toBe('')
  })
})

describe('Supabase 연결 설정 저장', () => {
  it('기본값은 비어 있다 — 설정 전에는 로컬 전용', () => {
    expect(DEFAULT_SETTINGS.syncSupabaseUrl).toBe('')
    expect(DEFAULT_SETTINGS.syncSupabaseAnonKey).toBe('')
  })

  it('올바른 값은 공백을 잘라 그대로 저장한다', () => {
    const s = parseSettings({
      syncSupabaseUrl: ' https://abcdefghijkl.supabase.co ',
      syncSupabaseAnonKey: ' sb_publishable_abcdefghijklmnop '
    })
    expect(s.syncSupabaseUrl).toBe('https://abcdefghijkl.supabase.co')
    expect(s.syncSupabaseAnonKey).toBe('sb_publishable_abcdefghijklmnop')
  })

  it('형식이 어긋나거나 비밀 키면 빈 값으로 되돌린다', () => {
    const s = parseSettings({
      syncSupabaseUrl: 'http://not-https',
      syncSupabaseAnonKey: 'sb_secret_abcdefghijklmnop'
    })
    expect(s.syncSupabaseUrl).toBe('')
    expect(s.syncSupabaseAnonKey).toBe('')
  })

  it('동기화 대상 설정 목록에 들어가지 않는다(기기 로컬 값)', () => {
    const keys: readonly string[] = SYNCED_SETTING_KEYS
    expect(keys).not.toContain('syncSupabaseUrl')
    expect(keys).not.toContain('syncSupabaseAnonKey')
  })
})
