// 신원정보는 계정마다 다시 적지 않는다 — 계정에 없으면 전역 신원정보에서 채운다

process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

describe('전역 신원정보 폴백', () => {
  let db: Db
  let vault: VaultService
  let accountId: number

  const identity = (accountIdOrNull: number | null, phone: string): void => {
    vault.putItem({
      accountId: accountIdOrNull,
      type: 'identity',
      label: '신원정보',
      sections: [
        {
          key: 'identity',
          label: '신원정보',
          fields: [{ key: 'identity.phone', label: '휴대폰', kind: 'text', value: phone }]
        }
      ]
    })
  }

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    const value: Settings = { ...DEFAULT_SETTINGS }
    vault = new VaultService(db, { get: () => value })
    await vault.setup('master-pw')
    accountId = vault.upsertAccount({
      host: 'www.musinsa.com',
      label: 'bob',
      username: 'bob',
      isDefault: true
    }).id
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('계정에 신원정보가 없으면 전역 신원정보의 값을 쓴다', () => {
    identity(null, '01012345678')
    expect(vault.getSecretForFill(accountId, 'identity', 'identity.phone')).toBe('01012345678')
  })

  it('계정에 값이 있으면 그것이 먼저다', () => {
    identity(null, '01012345678')
    identity(accountId, '01099998888')
    expect(vault.getSecretForFill(accountId, 'identity', 'identity.phone')).toBe('01099998888')
  })

  it("필드 키를 뒤쪽만('phone') 불러도 찾는다", () => {
    identity(null, '01012345678')
    expect(vault.getSecretForFill(accountId, 'identity', 'phone')).toBe('01012345678')
  })

  it('어디에도 없으면 null, 잠겨 있으면 null', () => {
    expect(vault.getSecretForFill(accountId, 'identity', 'identity.phone')).toBeNull()
    identity(null, '01012345678')
    vault.lock()
    expect(vault.getSecretForFill(accountId, 'identity', 'identity.phone')).toBeNull()
  })

  it('카드·로그인은 전역 항목으로 넘겨 쓰지 않는다', () => {
    vault.putItem({
      accountId: null,
      type: 'card',
      label: '카드',
      sections: [
        {
          key: 'card',
          label: '카드',
          fields: [{ key: 'card.number', label: '번호', kind: 'secret', value: '4111111111111111' }]
        }
      ]
    })
    expect(vault.getSecretForFill(accountId, 'card', 'card.number')).toBeNull()
  })
})
