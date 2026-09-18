import { describe, it, expect } from 'vitest'
import {
  sharedCredentialDomains,
  knownLoginUrl,
  changePasswordUrl,
  appendsTwoFactorToPassword,
  normalizeRuleHost,
  isLikelyLoginUrl,
  correctLoginUrl,
  KNOWN_LOGIN_URLS
} from '../src/shared/site-rules'

describe('sharedCredentialDomains', () => {
  it('같은 계정을 공유하는 도메인 그룹을 돌려준다', () => {
    const domains = sharedCredentialDomains('www.adobelogin.com')
    expect(domains).toContain('adobelogin.com')
    expect(domains).toContain('adobe.com')
  })

  it('규칙에 없는 호스트는 자기 자신만 돌려준다', () => {
    expect(sharedCredentialDomains('example.invalid')).toEqual(['example.invalid'])
  })
})

describe('knownLoginUrl', () => {
  it('국내 주요 사이트의 로그인 URL 을 서브도메인에서도 찾는다', () => {
    expect(knownLoginUrl('www.naver.com')).toBe('https://nid.naver.com/nidlogin.login')
    expect(knownLoginUrl('shopping.naver.com')).toBe('https://nid.naver.com/nidlogin.login')
    expect(knownLoginUrl('www.coupang.com')).toBe('https://login.coupang.com/login/login.pang')
    expect(knownLoginUrl('unknown.invalid')).toBeUndefined()
  })

  it('E2E 에서 loginUrl 이 어긋났던 국내 사이트 규칙이 채워져 있다', () => {
    expect(knownLoginUrl('www.musinsa.com')).toBe('https://www.musinsa.com/auth/login')
    expect(knownLoginUrl('www.29cm.co.kr')).toBe('https://www.29cm.co.kr/mypage/login')
    expect(knownLoginUrl('www.fashionplus.co.kr')).toBe('https://www.fashionplus.co.kr/auth/login')
    expect(knownLoginUrl('with.gsshop.com')).toBe('https://with.gsshop.com/login/loginForm.gs')
    expect(knownLoginUrl('samba-wave.vercel.app')).toBe('https://samba-wave.vercel.app/samba/login')
    expect(knownLoginUrl('samba-wave.co.kr')).toBe('https://samba-wave.co.kr/samba/login')
    expect(knownLoginUrl('www.ebay.com')).toBe('https://signin.ebay.com/ws/eBayISAPI.dll?SignIn')
  })
})

describe('isLikelyLoginUrl', () => {
  it('로그인 페이지로 보이는 URL 을 통과시킨다', () => {
    const likely = [
      'https://nid.naver.com/nidlogin.login',
      'https://www.musinsa.com/auth/login',
      'https://ohou.se/users/sign_in',
      'https://www.yes24.com/Templates/FTLogIn.aspx',
      'https://login.aliexpress.com/',
      'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn',
      'https://www.29cm.co.kr/mypage/login'
    ]
    for (const url of likely) expect(isLikelyLoginUrl(url), url).toBe(true)
  })

  it('가입폼·회원정보 수정·홈은 로그인 페이지로 보지 않는다', () => {
    const unlikely = [
      'https://www.29cm.co.kr/mypage/edit/reconfirm',
      'https://www.musinsa.com/member/join',
      'https://samba-wave.vercel.app/samba/sign-up',
      'https://accounts.example.com/auth/signup',
      'https://www.example.com/',
      'https://www.example.com/blog/authority-guide',
      'javascript:void(0)',
      ''
    ]
    for (const url of unlikely) expect(isLikelyLoginUrl(url), url).toBe(false)
  })

  it('KNOWN_LOGIN_URLS 의 모든 값이 로그인 URL 판정을 통과한다', () => {
    for (const [host, url] of Object.entries(KNOWN_LOGIN_URLS)) {
      expect(isLikelyLoginUrl(url), `${host} → ${url}`).toBe(true)
    }
  })
})

describe('correctLoginUrl', () => {
  it('로그인 페이지가 아니고 알려진 URL 이 있으면 바꾼다', () => {
    expect(correctLoginUrl('www.29cm.co.kr', 'https://www.29cm.co.kr/mypage/edit/reconfirm')).toBe(
      'https://www.29cm.co.kr/mypage/login'
    )
    expect(
      correctLoginUrl('samba-wave.vercel.app', 'https://samba-wave.vercel.app/samba/sign-up')
    ).toBe('https://samba-wave.vercel.app/samba/login')
    // URL 이 비어 있어도 알려진 로그인 URL 로 채운다
    expect(correctLoginUrl('www.musinsa.com', '')).toBe('https://www.musinsa.com/auth/login')
  })

  it('이미 로그인 페이지이거나 규칙이 없으면 원본을 유지한다', () => {
    expect(correctLoginUrl('www.musinsa.com', 'https://www.musinsa.com/auth/login')).toBe(
      'https://www.musinsa.com/auth/login'
    )
    expect(correctLoginUrl('shop.invalid', 'https://shop.invalid/mypage')).toBe(
      'https://shop.invalid/mypage'
    )
  })
})

describe('Apple 규칙 데이터', () => {
  it('비밀번호 변경 URL 과 2FA 결합 사이트를 조회한다', () => {
    expect(changePasswordUrl('www.11st.co.kr')).toMatch(/^https:\/\//)
    expect(appendsTwoFactorToPassword('www.etrade.com')).toBe(true)
    expect(appendsTwoFactorToPassword('naver.com')).toBe(false)
  })

  it('normalizeRuleHost 는 포트와 www 를 없앤다', () => {
    expect(normalizeRuleHost('WWW.Example.COM:8080')).toBe('example.com')
  })
})
