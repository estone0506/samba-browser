// 비밀번호 생성기 순수 함수 검증(crypto.getRandomValues 만 사용)

import { describe, it, expect } from 'vitest'
import {
  generatePassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH
} from '../src/renderer/src/lib/password'

const SYMBOL_RE = /[!@#$%^&*()\-_=+[\]{}<>?]/
const DIGIT_RE = /[0-9]/

describe('generatePassword', () => {
  it('요청한 길이만큼 만든다', () => {
    expect(generatePassword({ length: 20, symbols: true, digits: true })).toHaveLength(20)
  })

  it('길이는 허용 범위로 clamp 된다', () => {
    expect(generatePassword({ length: 1, symbols: true, digits: true })).toHaveLength(
      MIN_PASSWORD_LENGTH
    )
    expect(generatePassword({ length: 999, symbols: true, digits: true })).toHaveLength(
      MAX_PASSWORD_LENGTH
    )
  })

  it('기호·숫자를 끄면 그 문자가 나오지 않는다', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePassword({ length: 32, symbols: false, digits: false })
      expect(SYMBOL_RE.test(pw)).toBe(false)
      expect(DIGIT_RE.test(pw)).toBe(false)
    }
  })

  it('호출할 때마다 다른 값을 만든다', () => {
    const set = new Set<string>()
    for (let i = 0; i < 20; i++)
      set.add(generatePassword({ length: 16, symbols: true, digits: true }))
    expect(set.size).toBe(20)
  })
})
