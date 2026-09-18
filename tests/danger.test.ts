import { describe, it, expect } from 'vitest'
import { isDangerous, DEFAULT_DANGER_WORDS } from '@shared/danger'

describe('isDangerous', () => {
  it('위험 단어 포함 시 true', () => {
    expect(isDangerous('지금 결제하기')).toBe(true)
    expect(isDangerous('회원 탈퇴')).toBe(true)
  })
  it('없으면 false', () => {
    expect(isDangerous('장바구니 보기')).toBe(false)
  })
  it('기본 단어 목록 7개', () => {
    expect(DEFAULT_DANGER_WORDS).toHaveLength(7)
  })
})
