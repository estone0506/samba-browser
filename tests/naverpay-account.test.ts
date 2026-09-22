// 네이버페이 결제창의 로그인 계정 검사 — 우측 위 마스킹 아이디(cann******)를 키마스터 계정과 맞춘다
import { describe, it, expect } from 'vitest'
import {
  isNaverPayHost,
  maskedNaverAccount,
  maskedNaverAccountMatches
} from '../src/shared/naverpay'

describe('네이버페이 창 계정', () => {
  it('결제창 호스트를 알아본다', () => {
    expect(isNaverPayHost('m.pay.naver.com')).toBe(true)
    expect(isNaverPayHost('pay.naver.com')).toBe(true)
    expect(isNaverPayHost('nid.naver.com')).toBe(false)
    expect(isNaverPayHost('abcmart.a-rt.com')).toBe(false)
  })

  it('본문에서 마스킹된 아이디를 찾는다', () => {
    expect(maskedNaverAccount('N pay cann****** ✕ MR530AD 129,000원')).toBe('cann******')
    expect(maskedNaverAccount('네이버페이 - Whale\nedel****** ▾')).toBe('edel******')
    expect(maskedNaverAccount('별표 없음 *** 가격 129,000원')).toBeNull()
    expect(maskedNaverAccount('')).toBeNull()
  })

  it('앞부분이 같으면 같은 계정, 다르면 다른 계정', () => {
    expect(maskedNaverAccountMatches('edel******', 'buyer01')).toBe(true)
    expect(maskedNaverAccountMatches('EDEL******', 'buyer01')).toBe(true)
    expect(maskedNaverAccountMatches('cann******', 'buyer01')).toBe(false)
    expect(maskedNaverAccountMatches('cann******', 'buyer02')).toBe(true)
    // 이메일 아이디는 @ 앞부분
    expect(maskedNaverAccountMatches('anol******', 'anol06anol06@gmail.com')).toBe(true)
    // 보이는 글자가 아이디보다 길면 다른 계정
    expect(maskedNaverAccountMatches('buyer02x******', 'buyer02')).toBe(false)
    expect(maskedNaverAccountMatches('******', 'buyer02')).toBe(false)
  })
})

describe('accountGroupKey', () => {
  it('네이버 커머스만 따로, 나머지는 등록 도메인', async () => {
    const { accountGroupKey } = await import('../src/shared/host')
    expect(accountGroupKey('nid.naver.com')).toBe('naver.com')
    expect(accountGroupKey('mail.naver.com')).toBe('naver.com')
    expect(accountGroupKey('accounts.commerce.naver.com')).toBe('commerce.naver.com')
    expect(accountGroupKey('commerce.naver.com')).toBe('commerce.naver.com')
    expect(accountGroupKey('abcmart.a-rt.com')).toBe('a-rt.com')
  })
})
