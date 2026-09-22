// 목록 그룹 키(등록 가능 도메인)와 그룹 계산 검증

import { describe, it, expect } from 'vitest'
import { registrableDomain } from '../src/shared/host'
import { groupByDomain } from '../src/renderer/src/lib/vault-groups'
import type { AccountDto } from '../src/shared/vault'

function account(id: number, host: string, label = `계정${id}`): AccountDto {
  return {
    id,
    siteId: id,
    host,
    label,
    username: `user${id}`,
    isDefault: false,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: []
  }
}

describe('registrableDomain', () => {
  it('서브도메인을 하나의 도메인으로 접는다', () => {
    expect(registrableDomain('nid.naver.com')).toBe('naver.com')
    expect(registrableDomain('accounts.commerce.naver.com')).toBe('naver.com')
    expect(registrableDomain('https://www.naver.com/login')).toBe('naver.com')
  })

  it('두 단계 공개 접미사는 한 조각 더 남긴다', () => {
    expect(registrableDomain('shop.example.co.kr')).toBe('example.co.kr')
    expect(registrableDomain('mail.example.co.jp')).toBe('example.co.jp')
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk')
  })

  it('이미 도메인이면 그대로 둔다', () => {
    expect(registrableDomain('example.com')).toBe('example.com')
    expect(registrableDomain('localhost')).toBe('localhost')
  })

  it('IP 주소는 접지 않는다', () => {
    expect(registrableDomain('192.168.0.10')).toBe('192.168.0.10')
  })

  it('파싱할 수 없으면 빈 문자열', () => {
    expect(registrableDomain('')).toBe('')
  })
})

describe('groupByDomain', () => {
  it('같은 사이트 그룹의 계정을 모으고 이름순으로 정렬한다 — 네이버 커머스는 별개 그룹', () => {
    const groups = groupByDomain([
      account(1, 'nid.naver.com'),
      account(2, 'shop.example.com'),
      account(3, 'accounts.commerce.naver.com'),
      account(4, 'mail.naver.com')
    ])
    expect(groups.map((g) => g.key)).toEqual(['commerce.naver.com', 'example.com', 'naver.com'])
    expect(groups[2].accounts.map((a) => a.id)).toEqual([1, 4])
  })

  it('빈 목록이면 그룹도 없다', () => {
    expect(groupByDomain([])).toEqual([])
  })
})
