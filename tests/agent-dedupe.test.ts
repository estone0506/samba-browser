import { describe, it, expect } from 'vitest'
import { createTextDeduper } from '../src/main/agent/dedupe'

describe('createTextDeduper', () => {
  it('같은 문단은 한 번만 통과시킨다', () => {
    const d = createTextDeduper()
    expect(d.accept('안녕하세요')).toBe('안녕하세요')
    expect(d.accept('안녕하세요')).toBeNull()
    expect(d.count()).toBe(1)
  })

  it('공백·개행만 다른 문단도 같은 문단으로 본다', () => {
    const d = createTextDeduper()
    expect(d.accept('  검색 결과를 정리했습니다.\n')).toBe('검색 결과를 정리했습니다.')
    expect(d.accept('검색  결과를\n정리했습니다.')).toBeNull()
  })

  it('빈 문자열은 통과시키지 않는다', () => {
    const d = createTextDeduper()
    expect(d.accept('   \n')).toBeNull()
    expect(d.count()).toBe(0)
  })

  it('다른 문단은 순서대로 통과시킨다', () => {
    const d = createTextDeduper()
    expect(d.accept('첫째')).toBe('첫째')
    expect(d.accept('둘째')).toBe('둘째')
    expect(d.accept('첫째')).toBeNull()
    expect(d.count()).toBe(2)
  })
})
