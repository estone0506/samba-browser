// 하네스 읽기 API 주소 설정 — 기본 127.0.0.1:47812, 이 PC 값이라 동기화하지 않는다
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

describe('하네스 API 주소 설정', () => {
  it('기본값은 http://127.0.0.1:47812', () => {
    expect(DEFAULT_SETTINGS.harnessApiUrl).toBe('http://127.0.0.1:47812')
  })

  it('깨진 값은 기본값으로 돌아간다', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, harnessApiUrl: 42 }).harnessApiUrl).toBe(
      'http://127.0.0.1:47812'
    )
    expect(
      parseSettings({ ...DEFAULT_SETTINGS, harnessApiUrl: 'x'.repeat(500) }).harnessApiUrl
    ).toBe('http://127.0.0.1:47812')
  })

  it('주소는 동기화 대상이 아니다(이 PC 고유값)', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    expect(synced).not.toContain('harnessApiUrl')
  })
})
