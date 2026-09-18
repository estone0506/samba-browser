import { describe, it, expect } from 'vitest'
import {
  sharedCredentialDomains,
  knownLoginUrl,
  changePasswordUrl,
  appendsTwoFactorToPassword,
  normalizeHost
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
})

describe('Apple 규칙 데이터', () => {
  it('비밀번호 변경 URL 과 2FA 결합 사이트를 조회한다', () => {
    expect(changePasswordUrl('www.11st.co.kr')).toMatch(/^https:\/\//)
    expect(appendsTwoFactorToPassword('www.etrade.com')).toBe(true)
    expect(appendsTwoFactorToPassword('naver.com')).toBe(false)
  })

  it('normalizeHost 는 포트와 www 를 없앤다', () => {
    expect(normalizeHost('WWW.Example.COM:8080')).toBe('example.com')
  })
})
