// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

const MIN = 60 * 1000

// 테스트 도중 설정을 바꿀 수 있는 최소 SettingsReader 스텁
function makeSettings(patch: Partial<Settings> = {}): {
  get: () => Settings
  set: (p: Partial<Settings>) => void
} {
  let value: Settings = { ...DEFAULT_SETTINGS, vaultAutoLockMinutes: 15, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
    }
  }
}

describe('VaultService.holdAutoLock', () => {
  let db: Db

  beforeEach(async () => {
    vi.useFakeTimers()
    db = await openDatabase(':memory:')
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('보류 중에는 자동 잠금 만료가 와도 잠기지 않는다', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    v.holdAutoLock('agent run')

    vi.advanceTimersByTime(60 * MIN)
    expect(v.state()).toBe('unlocked')
    // 보류 구간마다 한 번만 알린다
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toBe('키마스터 자동 잠금 보류 중(AI 작업)')
    v.dispose()
    info.mockRestore()
  })

  it('보류를 풀면 그 시점부터 설정 분을 다시 센다', async () => {
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    const release = v.holdAutoLock('agent run')

    vi.advanceTimersByTime(60 * MIN)
    expect(v.state()).toBe('unlocked')

    release()
    // 해제 시점 + 15분 - 1ms 까지는 열려 있다
    vi.advanceTimersByTime(15 * MIN - 1)
    expect(v.state()).toBe('unlocked')
    vi.advanceTimersByTime(1)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('보류가 여럿이면 마지막 하나가 풀릴 때까지 잠기지 않는다', async () => {
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    const a = v.holdAutoLock('agent run')
    const b = v.holdAutoLock('schedule run')

    vi.advanceTimersByTime(60 * MIN)
    a()
    vi.advanceTimersByTime(60 * MIN)
    expect(v.state()).toBe('unlocked')

    b()
    vi.advanceTimersByTime(15 * MIN)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('같은 해제 함수를 여러 번 불러도 다른 보류를 풀지 않는다', async () => {
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    const a = v.holdAutoLock('agent run')
    v.holdAutoLock('schedule run')

    a()
    a()
    a()
    vi.advanceTimersByTime(60 * MIN)
    expect(v.state()).toBe('unlocked')
    v.dispose()
  })

  it('사용자가 직접 lock() 을 부르면 보류와 무관하게 즉시 잠근다', async () => {
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    v.holdAutoLock('agent run')

    v.lock()
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('설정이 꺼져 있으면 보류를 만들지 않는다', async () => {
    const v = new VaultService(db, makeSettings({ vaultHoldLockDuringAgent: false }))
    await v.setup('master-pw')
    v.holdAutoLock('agent run')

    vi.advanceTimersByTime(15 * MIN)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('보류를 잡은 뒤 설정을 끄면 예정대로 잠근다', async () => {
    const settings = makeSettings()
    const v = new VaultService(db, settings)
    await v.setup('master-pw')
    v.holdAutoLock('agent run')

    settings.set({ vaultHoldLockDuringAgent: false })
    vi.advanceTimersByTime(15 * MIN)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('잠긴 상태에서 보류를 풀어도 타이머를 되살리지 않는다', async () => {
    const v = new VaultService(db, makeSettings())
    await v.setup('master-pw')
    const release = v.holdAutoLock('agent run')
    v.lock()

    expect(() => release()).not.toThrow()
    expect(v.state()).toBe('locked')
    v.dispose()
  })
})

describe('vaultHoldLockDuringAgent 설정 키', () => {
  it('기본값은 켬이고 깨진 값은 기본값으로 돌아간다', () => {
    expect(DEFAULT_SETTINGS.vaultHoldLockDuringAgent).toBe(true)
    expect(parseSettings({ vaultHoldLockDuringAgent: false }).vaultHoldLockDuringAgent).toBe(false)
    expect(parseSettings({ vaultHoldLockDuringAgent: '켜짐' }).vaultHoldLockDuringAgent).toBe(true)
  })

  it('기기 로컬 값이라 동기화 대상이 아니다', () => {
    expect(SYNCED_SETTING_KEYS as readonly string[]).not.toContain('vaultHoldLockDuringAgent')
  })
})

describe('AI 작업 중 잠금 보류 문구', () => {
  it('ko/en 양쪽에 라벨과 설명이 있다', () => {
    for (const bundle of [ko, en]) {
      const settings = (bundle as { vault: { settings: Record<string, string> } }).vault.settings
      expect(typeof settings.holdDuringAgent).toBe('string')
      expect(settings.holdDuringAgent.length).toBeGreaterThan(0)
      expect(typeof settings.holdDuringAgentDesc).toBe('string')
      expect(settings.holdDuringAgentDesc.length).toBeGreaterThan(0)
    }
  })
})
