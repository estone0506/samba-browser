// 탭 프로필 색 — 같은 이름은 같은 색, 기본 프로필은 색 없음, 다른 이름은 대체로 다른 색

import { describe, it, expect } from 'vitest'
import { profileColor, profileTint, profileHueIndex } from '../src/renderer/src/lib/profile-color'

describe('profileColor', () => {
  it('기본 프로필과 빈 값은 색이 없다', () => {
    expect(profileColor('default')).toBeNull()
    expect(profileColor(undefined)).toBeNull()
    expect(profileTint('')).toBeNull()
  })

  it('같은 이름은 언제나 같은 색이다', () => {
    expect(profileColor('buyer01')).toBe(profileColor('buyer01'))
    expect(profileTint('buyer01')).toContain('/ 0.15')
  })

  it('계정 이름들이 서로 다른 색상 색인을 받는다(실기 계정 4개)', () => {
    const names = ['buyer01', 'buyer05', 'buyer06', 'buyer02']
    const idx = new Set(names.map(profileHueIndex))
    expect(idx.size).toBe(names.length)
  })
})
