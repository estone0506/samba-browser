// 마스터 비밀번호 폐지 — 계정(로그인) 비밀번호가 곧 키마스터 열쇠다
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { VAULT_KEY_SYNC_KEYS, type VaultKeySyncKey } from '../src/shared/sync'

function settings(): { get: () => Settings } {
  return { get: () => ({ ...DEFAULT_SETTINGS }) }
}

/** 다른 PC 가 비밀번호 master 로 만든 금고의 키 재료 */
async function remoteMaterial(master: string): Promise<Partial<Record<VaultKeySyncKey, string>>> {
  const db = await openDatabase(':memory:')
  const other = new VaultService(db, settings())
  await other.setup(master)
  const out: Partial<Record<VaultKeySyncKey, string>> = {}
  for (const k of VAULT_KEY_SYNC_KEYS) {
    const v = other.readKeyMaterial(k)
    if (v !== null) out[k] = v
  }
  other.dispose()
  db.close()
  return out
}

describe('adoptAccountPassword', () => {
  let db: Db
  let vault: VaultService
  const recorded: Array<[string, string, string]> = []

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, settings())
    recorded.length = 0
    vault.setOutboxRecorder((table, id, op) => recorded.push([table, id, op]))
  })
  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('금고가 없으면 계정 비밀번호로 만들고 키 재료를 올린다', async () => {
    expect(await vault.adoptAccountPassword('account-pw')).toBe('setup')
    expect(vault.state()).toBe('unlocked')
    const keys = recorded.filter(([t]) => t === 'settings').map(([, id]) => id)
    for (const k of VAULT_KEY_SYNC_KEYS) expect(keys).toContain(k)
  })

  it('빈 비밀번호는 아무것도 하지 않는다', async () => {
    expect(await vault.adoptAccountPassword('')).toBe('failed')
    expect(vault.state()).toBe('uninitialized')
  })

  it('옛 마스터로 잠긴 금고가 열려 있으면 계정 비밀번호로 다시 잠근다', async () => {
    await vault.setup('old-master')
    const account = vault.upsertAccount({ host: 'example.com', username: 'alice' })
    const item = vault.putItem({ accountId: account.id, type: 'login', label: 'L', value: 's3' })
    recorded.length = 0
    expect(await vault.adoptAccountPassword('account-pw')).toBe('rekeyed')
    expect(vault.state()).toBe('unlocked')
    expect(vault.reveal(item.id)).toBe('s3')
    // 항목은 새 키로 다시 올라가고 키 재료도 새로 올라간다
    expect(recorded).toContainEqual(['vault_items', String(item.id), 'upsert'])
    expect(recorded.some(([t, id]) => t === 'settings' && id === 'vault.salt')).toBe(true)
    // 옛 마스터로는 더 이상 열리지 않고 계정 비밀번호로 열린다
    vault.lock()
    expect(await vault.unlock('old-master')).toBe(false)
    expect(await vault.unlock('account-pw')).toBe(true)
  })

  it('옛 마스터로 잠겨 있고 기기 키로도 못 열면 needs-old-master(아무것도 바꾸지 않는다)', async () => {
    await vault.setup('old-master')
    vault.lock()
    expect(await vault.adoptAccountPassword('account-pw')).toBe('needs-old-master')
    expect(vault.state()).toBe('locked')
    expect(await vault.unlock('old-master')).toBe(true)
  })

  it('이미 계정 비밀번호로 잠긴 금고면 already', async () => {
    await vault.setup('account-pw')
    expect(await vault.adoptAccountPassword('account-pw')).toBe('already')
    expect(vault.state()).toBe('unlocked')
  })

  it('잠겨 있는데 계정 비밀번호로 열리면 unlocked', async () => {
    await vault.setup('account-pw')
    vault.lock()
    expect(await vault.adoptAccountPassword('account-pw')).toBe('unlocked')
  })

  it('서버 재료가 다른 PC 것(같은 계정 비밀번호)이면 그 재료로 다시 잠근다', async () => {
    await vault.setup('old-master')
    const account = vault.upsertAccount({ host: 'example.com', username: 'alice' })
    const item = vault.putItem({ accountId: account.id, type: 'login', label: 'L', value: 's3' })
    const remote = await remoteMaterial('account-pw')
    expect(vault.applyKeyMaterial(remote)).toBe('mismatch')
    expect(await vault.adoptAccountPassword('account-pw')).toBe('rekeyed-to-remote')
    expect(vault.hasPendingRemoteKey()).toBe(false)
    expect(vault.reveal(item.id)).toBe('s3')
    expect(vault.applyKeyMaterial(remote)).toBe('unchanged')
  })

  it('서버 재료가 옛 마스터 것이면(계정 비밀번호와 다름) 이 PC 는 계정 비밀번호 그대로 둔다', async () => {
    await vault.setup('account-pw')
    const remote = await remoteMaterial('other-old-master')
    expect(vault.applyKeyMaterial(remote)).toBe('mismatch')
    expect(await vault.adoptAccountPassword('account-pw')).toBe('already')
    expect(vault.state()).toBe('unlocked')
  })
})
