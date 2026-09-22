// 같은 사이트(등록 도메인) 같은 아이디 계정은 하나 — 서브도메인마다 생기지 않고, 흩어진 것은 합친다
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { VaultRepo } from '../src/main/vault/repo'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

function settings(): { get: () => Settings } {
  return { get: () => ({ ...DEFAULT_SETTINGS }) }
}

describe('서브도메인 계정 합치기', () => {
  let db: Db
  let vault: VaultService
  let repo: VaultRepo

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, settings())
    repo = new VaultRepo(db)
    await vault.setup('pw')
  })
  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('서브도메인별로 계정이 다른 사이트(네이버)는 합치지 않는다', () => {
    repo.upsertAccount({ host: 'nid.naver.com', username: 'buyer02' })
    repo.upsertAccount({ host: 'accounts.commerce.naver.com', username: 'buyer02' })
    expect(vault.mergeDomainAccounts('naver.com')).toEqual({ token: null, kept: 0, removed: 0 })
    expect(vault.listAccounts()).toHaveLength(2)
  })

  it('다른 서브도메인에서 같은 아이디를 저장하면 별개 계정이다(비밀번호가 다를 수 있다)', () => {
    const a = vault.upsertAccount({ host: 'nid.naver.com', username: 'buyer02' })
    const b = vault.upsertAccount({ host: 'mail.naver.com', username: 'buyer02' })
    expect(b.id).not.toBe(a.id)
  })

  it('hasSameSecret 도 같은 도메인의 계정을 본다', () => {
    const a = vault.upsertAccount({ host: 'abcmart.a-rt.com', username: 'buyer02' })
    vault.putItem({ accountId: a.id, type: 'login', label: 'L', value: 'pw1' })
    expect(vault.hasSameSecret('member.a-rt.com', 'buyer02', 'pw1')).toBe(true)
    expect(vault.hasSameSecret('member.a-rt.com', 'buyer02', 'pw2')).toBe(false)
  })

  it('흩어진 계정을 합친다 — 항목을 옮기고 호스트를 등록 도메인으로, 나머지는 지우되 되돌릴 수 있다', () => {
    // 옛 데이터처럼 서브도메인마다 따로 만들어진 상태를 repo 로 직접 만든다
    const a = repo.upsertAccount({
      host: 'abcmart.a-rt.com',
      username: 'buyer02',
      urls: ['https://abcmart.a-rt.com']
    })
    const b = repo.upsertAccount({
      host: 'grandstage.a-rt.com',
      username: 'buyer02',
      isDefault: true
    })
    const c = repo.upsertAccount({ host: 'member.a-rt.com', username: 'buyer02', tags: ['vip'] })
    const other = repo.upsertAccount({ host: 'member.a-rt.com', username: 'someone' })
    const login = vault.putItem({ accountId: a.id, type: 'login', label: 'L', value: 'pw1' })
    const pay = vault.putItem({ accountId: b.id, type: 'password', label: 'P', value: '1234' })
    vault.putItem({ accountId: c.id, type: 'login', label: 'L2', value: 'stale' })
    expect(vault.listAccounts()).toHaveLength(4)

    const r = vault.mergeDomainAccounts('a-rt.com')
    expect(r).toMatchObject({ kept: 2, removed: 2 })
    expect(r.token).not.toBeNull()
    const left = vault.listAccounts()
    expect(left).toHaveLength(2)
    const merged = left.find((x) => x.username === 'buyer02')
    // 항목 수가 같으면(각 1개) 기본 계정(b)이 남는다
    expect(merged?.id).toBe(b.id)
    expect(merged?.host).toBe('a-rt.com')
    expect(merged?.isDefault).toBe(true)
    expect(merged?.urls).toEqual(['https://abcmart.a-rt.com'])
    expect(merged?.tags).toEqual(['vip'])
    expect([...(merged?.itemTypes ?? [])].sort()).toEqual(['login', 'password'])
    // 옮겨진 항목은 그대로 풀린다(AAD 가 항목 id 기준이라 계정이 바뀌어도 된다)
    expect(vault.reveal(pay.id)).toBe('1234')
    expect(vault.reveal(login.id)).toBe('pw1')
    expect(left.find((x) => x.username === 'someone')?.id).toBe(other.id)
    // 합친 계정은 어느 서브도메인에서도 잡힌다
    expect(
      vault
        .listAccounts('member.a-rt.com')
        .map((x) => x.username)
        .sort()
    ).toEqual(['buyer02', 'someone'])
    // 되돌리기
    expect(vault.undoDeleteAccounts(r.token as string)).toBe(true)
    expect(vault.listAccounts()).toHaveLength(4)
  })

  it('중복이 없으면 아무것도 지우지 않는다', () => {
    vault.upsertAccount({ host: 'example.com', username: 'a' })
    vault.upsertAccount({ host: 'example.com', username: 'b' })
    expect(vault.mergeDomainAccounts('example.com')).toEqual({ token: null, kept: 2, removed: 0 })
    expect(vault.listAccounts()).toHaveLength(2)
  })

  it('쇼핑몰 계정의 네이버페이 항목이 네이버 계정 연결이면 그 계정의 결제 비밀번호를 쓴다', () => {
    const naverMail = vault.upsertAccount({ host: 'mail.naver.com', username: 'buyer01' })
    const naver = vault.upsertAccount({ host: 'nid.naver.com', username: 'buyer01' })
    const site = vault.upsertAccount({ host: 'abcmart.a-rt.com', username: 'buyer02' })
    const payFields = (
      extra: { key: string; label: string; kind: 'text' | 'secret'; value?: string }[]
    ) => [
      {
        key: 'main',
        label: '결제',
        fields: [
          { key: 'payment.provider', label: '결제 수단', kind: 'text' as const, value: 'naver' },
          ...extra
        ]
      }
    ]
    // 네이버 계정(nid)에만 실제 비밀번호. mail 계정은 같은 아이디지만 항목이 없다
    vault.putItem({
      accountId: naver.id,
      type: 'password',
      label: '네이버페이',
      sections: payFields([{ key: 'value', label: '비밀번호', kind: 'secret', value: '246810' }])
    })
    // 쇼핑몰 계정에는 "buyer01 계정을 쓴다"만
    vault.putItem({
      accountId: site.id,
      type: 'password',
      label: '네이버페이',
      sections: payFields([
        { key: 'payment.account', label: '계정', kind: 'text', value: 'buyer01' }
      ])
    })
    expect(vault.hasPaymentItem(site.id, 'naver')).toBe(true)
    // 결제창 계정 검사에 쓸 아이디: 쇼핑몰 계정은 연결된 아이디, 네이버 계정은 제 아이디
    expect(vault.paymentAccountUsername(site.id, 'naver')).toBe('buyer01')
    expect(vault.paymentAccountUsername(naver.id, 'naver')).toBe('buyer01')
    expect(vault.paymentAccountUsername(site.id, 'toss')).toBeNull()
    expect(vault.getPaymentSecretForFill({ accountId: site.id, provider: 'naver' }).value).toBe(
      '246810'
    )
    // 연결된 아이디가 없으면 not-found
    vault.putItem({
      accountId: site.id,
      type: 'password',
      label: '네이버페이',
      sections: payFields([
        { key: 'payment.account', label: '계정', kind: 'text', value: 'nobody' }
      ])
    })
    expect(vault.getPaymentSecretForFill({ accountId: site.id, provider: 'naver' })).toEqual({
      value: null,
      reason: 'not-found'
    })
    expect(naverMail.id).not.toBe(naver.id)
  })
})
