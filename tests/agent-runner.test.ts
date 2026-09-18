import { describe, it, expect } from 'vitest'
import { makeCounter } from '../src/main/agent/counter'
import { classifyAuthError, isFatalApiError } from '../src/main/agent/provider'

describe('호출 카운터', () => {
  it('상한 도달 시 메시지 반환', () => {
    const c = makeCounter(2)
    expect(c.tick()).toBeNull()
    expect(c.tick()).toBeNull()
    expect(c.tick()).toMatch(/limit/)
    expect(c.count()).toBe(3)
  })
})

describe('classifyAuthError', () => {
  it('로그인 없음', () => expect(classifyAuthError('Error: Not logged in')).toBe('missing'))
  it('한도', () => expect(classifyAuthError('rate limit exceeded')).toBe('limit'))
  it('기타', () => expect(classifyAuthError('boom')).toBeNull())
})

describe('classifyAuthError — SDK 실측 문구', () => {
  it('api_retry 의 authentication_failed', () =>
    expect(classifyAuthError('authentication_failed 401')).toBe('missing'))
  it('API 원문 invalid x-api-key', () =>
    expect(classifyAuthError('invalid x-api-key')).toBe('missing'))
  it('authentication_error 타입', () =>
    expect(classifyAuthError('{"type":"authentication_error"}')).toBe('missing'))
  it('oauth 만료', () =>
    expect(classifyAuthError('OAuth token expired, please login')).toBe('missing'))
  it('실측 result 문구', () =>
    expect(classifyAuthError('Failed to authenticate. API Error: 401 API key is invalid.')).toBe(
      'missing'
    ))
  it('rate_limit', () => expect(classifyAuthError('rate_limit 429')).toBe('limit'))
  it('billing_error 는 인증이 아니라 한도 안내', () =>
    expect(classifyAuthError('billing_error')).toBe('limit'))
})

describe('classifyAuthError — 오분류 방지', () => {
  it("모델 요약의 'login' 단어만으로는 인증 오류가 아니다", () => {
    expect(classifyAuthError('로그인 페이지로 이동했습니다')).toBeNull()
    expect(classifyAuthError('Clicked the login button')).toBeNull()
    expect(classifyAuthError('Opened the Login page and stopped')).toBeNull()
  })
  it('실제 인증 실패 문구는 여전히 잡는다', () => {
    expect(classifyAuthError('Please login with claude login')).toBe('missing')
    expect(classifyAuthError('Error: Not logged in')).toBe('missing')
  })
})

describe('isFatalApiError', () => {
  it('인증 실패는 재시도 무의미', () => expect(isFatalApiError('authentication_failed')).toBe(true))
  it('과부하는 재시도 가능', () => expect(isFatalApiError('overloaded')).toBe(false))
  it('한도는 재시도 가능', () => expect(isFatalApiError('rate_limit')).toBe(false))
})
