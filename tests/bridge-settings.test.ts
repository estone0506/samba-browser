// 브릿지 설정 키 — 기본 꺼짐, 포트 범위 검사, 토큰은 이 PC 에만 남는다
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

describe('브릿지 설정', () => {
  it('기본값은 꺼짐·47811·빈 토큰', () => {
    expect(DEFAULT_SETTINGS.bridgeEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.bridgePort).toBe(47811)
    expect(DEFAULT_SETTINGS.bridgeToken).toBe('')
  })

  it('깨진 값은 기본값으로 돌아간다(포트 범위 1024~65535)', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      bridgePort: 80,
      bridgeEnabled: 'yes',
      bridgeToken: 42
    })
    expect(s.bridgePort).toBe(47811)
    expect(s.bridgeEnabled).toBe(false)
    expect(s.bridgeToken).toBe('')
  })

  it('토큰·포트·켬은 동기화 대상이 아니다(이 PC 고유값)', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    for (const key of ['bridgeEnabled', 'bridgePort', 'bridgeToken'])
      expect(synced).not.toContain(key)
  })
})
