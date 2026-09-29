import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, migrateSettingsFile, parseSettings } from '../src/shared/settings'

describe('로그인 자동 저장 기본값·1회 마이그레이션', () => {
  it('새 설치 기본값은 묻지 않고 자동 저장(켬)이다', () => {
    expect(DEFAULT_SETTINGS.vaultAutoSaveLogins).toBe(true)
    expect(parseSettings({}).vaultAutoSaveLogins).toBe(true)
  })

  it('예전 저장 파일의 꺼짐 값을 한 번 켬으로 옮기고 표시를 남긴다', () => {
    const migrated = migrateSettingsFile({ language: 'ko', vaultAutoSaveLogins: false })
    expect(migrated).not.toBeNull()
    const s = parseSettings(migrated)
    expect(s.vaultAutoSaveLogins).toBe(true)
    expect(s.vaultAutoSaveLoginsMigrated).toBe(true)
    // 다른 값은 그대로 둔다
    expect(s.language).toBe('ko')
  })

  it('마이그레이션을 마친 뒤 사용자가 끈 값은 다시 바꾸지 않는다', () => {
    expect(
      migrateSettingsFile({ vaultAutoSaveLogins: false, vaultAutoSaveLoginsMigrated: true })
    ).toBeNull()
  })

  it('저장 파일이 객체가 아니면 건드리지 않는다', () => {
    expect(migrateSettingsFile(null)).toBeNull()
    expect(migrateSettingsFile([1, 2])).toBeNull()
    expect(migrateSettingsFile('x')).toBeNull()
  })
})
