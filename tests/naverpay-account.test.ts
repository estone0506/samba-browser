// 네이버페이 결제창의 로그인 계정 검사 — 우측 위 마스킹 아이디(hong******)를 키마스터 계정과 맞춘다
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
    expect(maskedNaverAccount('N pay hong****** ✕ MR530AD 129,000원')).toBe('hong******')
    expect(maskedNaverAccount('네이버페이 - Whale\nmjki****** ▾')).toBe('mjki******')
    expect(maskedNaverAccount('별표 없음 *** 가격 129,000원')).toBeNull()
    expect(maskedNaverAccount('')).toBeNull()
  })

  it('앞부분이 같으면 같은 계정, 다르면 다른 계정', () => {
    expect(maskedNaverAccountMatches('mjki******', 'mjkim88')).toBe(true)
    expect(maskedNaverAccountMatches('MJKI******', 'mjkim88')).toBe(true)
    expect(maskedNaverAccountMatches('hong******', 'mjkim88')).toBe(false)
    expect(maskedNaverAccountMatches('hong******', 'hong77')).toBe(true)
    // 이메일 아이디는 @ 앞부분
    expect(maskedNaverAccountMatches('kims******', 'kimsun@example.com')).toBe(true)
    // 보이는 글자가 아이디보다 길면 다른 계정
    expect(maskedNaverAccountMatches('hong77x******', 'hong77')).toBe(false)
    expect(maskedNaverAccountMatches('******', 'hong77')).toBe(false)
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

describe('비밀번호 입력 화면의 "이름(아이디)님" 표기', () => {
  it('마스킹이 없고 아이디가 통째로 보이면 그 아이디를 읽고 정확히 대조한다', () => {
    const text = '네이버페이 인증\n김사무(buyer01)님의 비밀번호 입력\n비밀번호는 6자리 입니다.'
    expect(maskedNaverAccount(text)).toBe('buyer01')
    expect(maskedNaverAccountMatches('buyer01', 'buyer01')).toBe(true)
    expect(maskedNaverAccountMatches('buyer01', 'edelvise07')).toBe(false)
    expect(maskedNaverAccountMatches('buyer01', 'edelvise')).toBe(false)
  })

  it('마스킹 표기가 있으면 그쪽이 우선이다', () => {
    expect(maskedNaverAccount('edel****** 김사무(buyer01)님')).toBe('edel******')
  })
})

describe('pathOnly — 진행 라벨용 주소', () => {
  it('쿼리·해시를 떼고 호스트와 경로만 남긴다', async () => {
    const { pathOnly } = await import('../src/main/agent/tools')
    expect(pathOnly('https://pay.naver.com/authentication/pw/check?sessionKey=abc#x')).toBe(
      'pay.naver.com/authentication/pw/check'
    )
    expect(pathOnly('not a url')).toBe('not a url')
  })
})
