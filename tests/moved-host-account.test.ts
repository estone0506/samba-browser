import { describe, expect, it } from 'vitest'
import { movedHostAccount } from '../src/main/agent/tools'
import type { AccountDto } from '../src/shared/vault'

// 29CM → 무신사 통합 로그인처럼 다른 도메인으로 넘어갔을 때 짝 계정 고르기
const acc = (host: string, label: string, username: string): AccountDto =>
  ({
    id: 0,
    siteId: 0,
    host,
    label,
    username,
    isDefault: false,
    itemTypes: ['login', 'password'],
    urls: [],
    agentAccess: 'allow'
  }) as unknown as AccountDto

const cm29 = [
  acc('29cm.co.kr', 'buyer02@naver.com', 'buyer02'),
  acc('29cm.co.kr', 'buyer01@naver.com', 'buyer01')
]
const musinsa = [acc('musinsa.com', 'buyer01', 'buyer01'), acc('musinsa.com', 'buyer02', 'buyer02')]

describe('movedHostAccount', () => {
  it('원래 계정 아이디와 같은 통합 계정을 고른다', () => {
    expect(movedHostAccount(cm29, musinsa, 'buyer02@naver.com')?.label).toBe('buyer02')
  })

  it('원래 계정이 없어도 라벨 @ 앞부분으로 고른다', () => {
    expect(movedHostAccount([], musinsa, 'buyer01@naver.com')?.label).toBe('buyer01')
  })

  it('짝이 없으면 null — 다른 계정으로 로그인하지 않는다', () => {
    expect(movedHostAccount(cm29, musinsa, 'buyer03@naver.com')).toBeNull()
    expect(movedHostAccount(cm29, musinsa, undefined)).toBeNull()
  })
})
