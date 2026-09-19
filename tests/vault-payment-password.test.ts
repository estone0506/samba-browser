// 계정당 여러 개인 결제 비밀번호. 무신사처럼 한 계정에 무신사머니·토스페이·
// 카카오페이·페이코가 함께 붙는 경우를 다룬다.
//
// 가장 중요한 단언: 어느 결제 수단인지 좁히지 못하면 아무 값도 돌려주지 않는다 —
// 잘못된 비밀번호를 누르면 계정이 잠기기 때문이다.

// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELD_KEY,
  normalizePaymentProvider,
  paymentProviderOfSections,
  type PaymentProvider
} from '../src/shared/vault'

function makeSettings(): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS }
  return { get: () => value }
}

describe('결제 비밀번호 제공자', () => {
  let db: Db
  let vault: VaultService
  let accountId: number

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, makeSettings())
    await vault.setup('master-pw')
    accountId = vault.upsertAccount({
      host: 'www.musinsa.com',
      label: '무신사',
      username: 'alice',
      isDefault: true
    }).id
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  /** 계정에 결제 비밀번호 한 개를 붙인다. provider 를 생략하면 제공자 필드가 없는 옛 항목이다 */
  function addPayment(label: string, value: string, provider?: PaymentProvider): number {
    return vault.putItem({
      accountId,
      type: 'password',
      label,
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            ...(provider
              ? [
                  {
                    key: PAYMENT_PROVIDER_FIELD_KEY,
                    label: '결제 수단',
                    kind: 'select' as const,
                    value: provider
                  }
                ]
              : []),
            { key: 'value', label: '비밀번호', kind: 'secret' as const, value }
          ]
        }
      ]
    }).id
  }

  it('제공자 값 목록은 8종이고 모르는 값은 site 로 정규화된다', () => {
    expect([...PAYMENT_PROVIDERS]).toEqual([
      'site',
      'toss',
      'kakao',
      'naver',
      'payco',
      'samsung',
      'apple',
      'other'
    ])
    expect(normalizePaymentProvider('toss')).toBe('toss')
    expect(normalizePaymentProvider('unknown')).toBe('site')
    expect(normalizePaymentProvider(null)).toBe('site')
    expect(paymentProviderOfSections([])).toBe('site')
  })

  it('같은 계정에 결제 수단별로 여러 개가 저장된다(덮어쓰지 않는다)', () => {
    addPayment('무신사머니', '111111', 'site')
    addPayment('토스페이', '222222', 'toss')
    addPayment('페이코', '333333', 'payco')

    const items = vault.listItems(accountId).filter((i) => i.type === 'password')
    expect(items).toHaveLength(3)
    expect(items.map((i) => paymentProviderOfSections(i.sections)).sort()).toEqual([
      'payco',
      'site',
      'toss'
    ])
  })

  it('같은 결제 수단을 다시 저장하면 새로 만들지 않고 값을 갱신한다', () => {
    const first = addPayment('토스페이', '222222', 'toss')
    const again = addPayment('토스페이', '999999', 'toss')

    expect(again).toBe(first)
    expect(vault.listItems(accountId).filter((i) => i.type === 'password')).toHaveLength(1)
    expect(vault.getPaymentSecretForFill({ accountId, provider: 'toss' })).toEqual({
      value: '999999'
    })
  })

  it('제공자를 지정하면 그 결제 수단의 값만 돌려준다', () => {
    addPayment('무신사머니', '111111', 'site')
    addPayment('토스페이', '222222', 'toss')

    expect(vault.getPaymentSecretForFill({ accountId, provider: 'site' }).value).toBe('111111')
    expect(vault.getPaymentSecretForFill({ accountId, provider: 'toss' }).value).toBe('222222')
  })

  it('저장되지 않은 결제 수단은 not-found 다(다른 수단 값으로 대신하지 않는다)', () => {
    addPayment('무신사머니', '111111', 'site')

    expect(vault.getPaymentSecretForFill({ accountId, provider: 'kakao' })).toEqual({
      value: null,
      reason: 'not-found'
    })
  })

  it('제공자를 안 줘도 계정에 결제 비밀번호가 하나뿐이면 그것을 쓴다', () => {
    addPayment('무신사머니', '111111', 'site')

    expect(vault.getPaymentSecretForFill({ accountId }).value).toBe('111111')
  })

  it('제공자를 안 줬는데 둘 이상이면 ambiguous — 임의로 고르지 않는다', () => {
    addPayment('무신사머니', '111111', 'site')
    addPayment('토스페이', '222222', 'toss')

    expect(vault.getPaymentSecretForFill({ accountId })).toEqual({
      value: null,
      reason: 'ambiguous'
    })
  })

  it('저장된 항목이 하나도 없으면 not-found', () => {
    expect(vault.getPaymentSecretForFill({ accountId })).toEqual({
      value: null,
      reason: 'not-found'
    })
  })

  it('잠겨 있으면 locked 이며 값은 절대 나오지 않는다', () => {
    addPayment('무신사머니', '111111', 'site')
    vault.lock()

    expect(vault.getPaymentSecretForFill({ accountId, provider: 'site' })).toEqual({
      value: null,
      reason: 'locked'
    })
  })

  it('제공자 필드가 없는 옛 항목은 site 로 본다(마이그레이션 없이 읽힌다)', () => {
    addPayment('결제 비밀번호', '444444')

    const item = vault.listItems(accountId).find((i) => i.type === 'password')
    expect(item && paymentProviderOfSections(item.sections)).toBe('site')
    expect(vault.getPaymentSecretForFill({ accountId, provider: 'site' }).value).toBe('444444')
  })

  it('getSecretForFill 도 password 종류면 제공자로 좁혀 읽는다', () => {
    addPayment('무신사머니', '111111', 'site')
    addPayment('토스페이', '222222', 'toss')

    expect(vault.getSecretForFill(accountId, 'password', 'value', 'job-1', 'ai', 'toss')).toBe(
      '222222'
    )
    // 제공자를 안 주면 모호하므로 아무 값도 내주지 않는다
    expect(vault.getSecretForFill(accountId, 'password')).toBeNull()
  })
})

describe('결제 비밀번호 i18n', () => {
  const bundles = { ko, en }

  it('ko/en 모두 결제 수단 8종의 라벨을 갖는다', () => {
    for (const [lang, bundle] of Object.entries(bundles)) {
      const labels = bundle.vault.paymentProvider as Record<string, string>
      expect(Object.keys(labels).sort(), lang).toEqual([...PAYMENT_PROVIDERS].sort())
      for (const value of Object.values(labels)) expect(value.length, lang).toBeGreaterThan(0)
    }
  })

  it('ko/en 결제 비밀번호 화면 문구가 대칭이다', () => {
    const detailKeys = ['paymentSection', 'addPayment', 'noPayment', 'deleteItem'] as const
    for (const [lang, bundle] of Object.entries(bundles)) {
      const detail = bundle.vault.detail as Record<string, unknown>
      for (const key of detailKeys) expect(typeof detail[key], `${lang}.${key}`).toBe('string')
      expect(typeof (bundle.vault.fieldNames as Record<string, unknown>).paymentProvider).toBe(
        'string'
      )
    }
  })
})
