// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { vaultMeta } from '../src/main/db/schema'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { randomBytes } from '../src/main/vault/crypto'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import {
  RECOVERY_ALPHABET,
  RECOVERY_KEY_CHARS,
  formatRecoveryKey,
  generateRecoveryKey,
  isValidRecoveryKey,
  normalizeRecoveryKey,
  unwrapMasterKey,
  wrapMasterKey
} from '../src/main/vault/recovery'

const MASTER_PW = 'master-pw!'
const RECOVERY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/

// SettingsStore 는 electron app 에 의존하므로 테스트에서는 최소 인터페이스만 흉내낸다
function makeSettings(patch: Partial<Settings> = {}): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return { get: () => value }
}

describe('복구 키 문자열', () => {
  it('24자 Crockford base32 를 4자씩 6그룹으로 만든다', () => {
    const key = generateRecoveryKey()
    expect(key).toMatch(RECOVERY_PATTERN)
    expect(key.replace(/-/g, '')).toHaveLength(RECOVERY_KEY_CHARS)
    // 혼동 문자(I·L·O·U)는 알파벳에 없다
    for (const ch of 'ILOU') expect(RECOVERY_ALPHABET).not.toContain(ch)
  })

  it('1000회 생성해도 중복이 없다', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i += 1) seen.add(generateRecoveryKey())
    expect(seen.size).toBe(1000)
  })

  it('정규화가 소문자·공백·하이픈·혼동 문자를 교정한다', () => {
    expect(normalizeRecoveryKey('k3f9 abcd-o1il 2345-6789-vwxy')).toBe('K3F9ABCD011123456789VWXY')
    // 대소문자·하이픈을 무시하므로 같은 키의 여러 표기가 같은 값으로 모인다
    const key = generateRecoveryKey()
    expect(normalizeRecoveryKey(key.toLowerCase())).toBe(normalizeRecoveryKey(key))
    expect(normalizeRecoveryKey(key.replace(/-/g, ' '))).toBe(normalizeRecoveryKey(key))
  })

  it('formatRecoveryKey 는 24자를 6그룹으로 끊는다', () => {
    expect(formatRecoveryKey('ABCDEFGHJKMNPQRSTVWXYZ01')).toBe('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01')
  })

  it('길이나 문자가 잘못되면 isValidRecoveryKey 가 false 다', () => {
    expect(isValidRecoveryKey(generateRecoveryKey())).toBe(true)
    expect(isValidRecoveryKey('ABCD-EFGH')).toBe(false) // 너무 짧다
    expect(isValidRecoveryKey('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345')).toBe(false) // 너무 길다
    expect(isValidRecoveryKey('ABCD-EFGH-JKMN-PQRS-TVWX-YZ0!')).toBe(false) // 알파벳 밖 문자
    expect(isValidRecoveryKey('')).toBe(false)
  })
})

describe('마스터 키 래핑', () => {
  it('wrapMasterKey → unwrapMasterKey 왕복으로 같은 마스터 키를 되찾는다', async () => {
    const master = randomBytes(32)
    const salt = randomBytes(16)
    const key = generateRecoveryKey()
    const blob = await wrapMasterKey(master, key, salt)
    // 감싼 결과에 마스터 키가 그대로 담겨 있지 않다
    expect(blob.ciphertext.includes(master)).toBe(false)
    const restored = await unwrapMasterKey(blob, key, salt)
    expect(restored.equals(master)).toBe(true)
    // 표기가 달라도(소문자·하이픈 없음) 같은 키로 푼다
    const loose = await unwrapMasterKey(blob, key.replace(/-/g, '').toLowerCase(), salt)
    expect(loose.equals(master)).toBe(true)
  })

  it('틀린 복구 키로는 예외가 난다', async () => {
    const master = randomBytes(32)
    const salt = randomBytes(16)
    const blob = await wrapMasterKey(master, generateRecoveryKey(), salt)
    await expect(unwrapMasterKey(blob, generateRecoveryKey(), salt)).rejects.toThrow()
  })
})

describe('VaultService 복구 키', () => {
  let db: Db
  let vault: VaultService

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, makeSettings())
    await vault.setup(MASTER_PW)
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  function metaValue(key: string): Buffer | null {
    const row = db.drizzle
      .select()
      .from(vaultMeta)
      .all()
      .find((r) => r.key === key)
    return row ? Buffer.from(row.value) : null
  }

  it('확인 전에는 recovery_wrapped_key 가 저장되지 않는다', async () => {
    const key = vault.createRecoveryKey()
    expect(key).toMatch(RECOVERY_PATTERN)
    expect(metaValue('recovery_wrapped_key')).toBeNull()
    expect(metaValue('recovery_salt')).toBeNull()

    expect(await vault.confirmRecoveryKey(key)).toBe(true)
    expect(metaValue('recovery_wrapped_key')).not.toBeNull()
    expect(metaValue('recovery_salt')).not.toBeNull()
  })

  it('복구 키는 기기 로컬이라 변경 로그에 아무것도 남기지 않는다', async () => {
    // 2b 결정: recovery_wrapped_key 는 이 기기에만 둔다(다른 PC 복구는 2c).
    // 예전에는 outbox 에 기록했지만 푸시 화이트리스트 밖이라 조용히 드롭됐다
    const outbox = new SyncOutbox(db)
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox))
    const key = vault.createRecoveryKey()

    expect(await vault.confirmRecoveryKey(key)).toBe(true)

    expect(outbox.pendingFor('settings')).toHaveLength(0)
    expect(outbox.count()).toBe(0)
  })

  it('재입력이 틀리면 false 를 돌려주고 아무것도 저장하지 않는다', async () => {
    vault.createRecoveryKey()
    expect(await vault.confirmRecoveryKey(generateRecoveryKey())).toBe(false)
    expect(metaValue('recovery_wrapped_key')).toBeNull()
    expect(metaValue('recovery_salt')).toBeNull()
  })

  it('발급하지 않았거나 이미 확인한 뒤에는 확인이 false 다', async () => {
    expect(await vault.confirmRecoveryKey(generateRecoveryKey())).toBe(false)
    const key = vault.createRecoveryKey()
    expect(await vault.confirmRecoveryKey(key)).toBe(true)
    // 보관하던 발급 값은 확인 직후 폐기된다
    expect(await vault.confirmRecoveryKey(key)).toBe(false)
  })

  it('복구 키로 잠긴 금고를 해제한다', async () => {
    const key = vault.createRecoveryKey()
    await vault.confirmRecoveryKey(key)
    vault.lock()
    expect(vault.state()).toBe('locked')

    expect(await vault.unlockWithRecoveryKey('nope')).toBe(false)
    expect(vault.state()).toBe('locked')
    expect(await vault.unlockWithRecoveryKey(generateRecoveryKey())).toBe(false)
    expect(vault.state()).toBe('locked')

    // 표기가 달라도(소문자·하이픈 없음) 해제된다
    expect(await vault.unlockWithRecoveryKey(key.replace(/-/g, '').toLowerCase())).toBe(true)
    expect(vault.state()).toBe('unlocked')
  })

  it('복구 키가 없으면 복구 해제는 false 다', async () => {
    vault.lock()
    expect(await vault.unlockWithRecoveryKey(generateRecoveryKey())).toBe(false)
  })

  it('감사 로그에 값 없이 recovery_create·recovery_unlock 이 남는다', async () => {
    const key = vault.createRecoveryKey()
    await vault.confirmRecoveryKey(key)
    vault.lock()
    await vault.unlockWithRecoveryKey(key)

    const actions = vault.listAudit().map((r) => r.action)
    expect(actions).toContain('recovery_create')
    expect(actions).toContain('recovery_unlock')
    const serialized = JSON.stringify(vault.listAudit())
    expect(serialized).not.toContain(normalizeRecoveryKey(key))
  })

  it('복구 키 평문이 DB 어디에도 남지 않는다', async () => {
    const key = vault.createRecoveryKey()
    await vault.confirmRecoveryKey(key)
    const compact = normalizeRecoveryKey(key)

    const rows = db.drizzle.select().from(vaultMeta).all()
    for (const row of rows) {
      const buf = Buffer.from(row.value)
      expect(buf.toString('utf8')).not.toContain(compact)
      expect(buf.toString('latin1')).not.toContain(compact)
      expect(buf.toString('base64')).not.toContain(compact)
      expect(buf.toString('hex')).not.toContain(Buffer.from(compact, 'utf8').toString('hex'))
    }
  })

  it('잠긴 상태에서는 복구 키를 발급할 수 없다', () => {
    vault.lock()
    expect(() => vault.createRecoveryKey()).toThrow()
  })
})
