import { describe, it, expect } from 'vitest'
import { makeCounter } from '../src/main/agent/counter'
import { classifyAuthError } from '../src/main/agent/provider'

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
