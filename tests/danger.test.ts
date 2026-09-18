import { describe, it, expect } from 'vitest'
import { isDangerous, mergeDangerWords, DEFAULT_DANGER_WORDS } from '@shared/danger'

describe('isDangerous', () => {
  it('한국어 위험 단어 포함 시 true', () => {
    expect(isDangerous('지금 결제하기')).toBe(true)
    expect(isDangerous('회원 탈퇴')).toBe(true)
  })
  it('영문 위험 단어도 잡는다', () => {
    expect(isDangerous('Place order')).toBe(true)
    expect(isDangerous('Proceed to checkout')).toBe(true)
    expect(isDangerous('Buy now')).toBe(true)
    expect(isDangerous('Delete account')).toBe(true)
    expect(isDangerous('Unsubscribe')).toBe(true)
  })
  it('없으면 false', () => {
    expect(isDangerous('장바구니 보기')).toBe(false)
    expect(isDangerous('Back to top')).toBe(false)
  })
  it('기본 목록은 한국어 7개 + 영문 9개', () => {
    expect(DEFAULT_DANGER_WORDS).toHaveLength(16)
  })
})

describe('mergeDangerWords', () => {
  it('인자가 없으면 기본 목록', () => {
    expect(mergeDangerWords()).toEqual(DEFAULT_DANGER_WORDS)
  })
  it('빈 문자열·공백은 버린다', () => {
    expect(mergeDangerWords(['', '   '])).toEqual(DEFAULT_DANGER_WORDS)
  })
  it('사용자 단어를 더해도 기본 단어는 유지된다', () => {
    const merged = mergeDangerWords(['환불'])
    expect(merged).toHaveLength(DEFAULT_DANGER_WORDS.length + 1)
    expect(isDangerous('환불 신청', merged)).toBe(true)
    expect(isDangerous('결제하기', merged)).toBe(true)
  })
})
