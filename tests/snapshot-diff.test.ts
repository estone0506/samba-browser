import { describe, it, expect } from 'vitest'
import { diffLines } from '../src/shared/snapshot-diff'

describe('diffLines', () => {
  it('같은 문자열이면 빈 문자열', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toBe('')
  })

  it('가운데 한 줄이 바뀌면 그 줄만 담는다', () => {
    const out = diffLines('a\nb\nc', 'a\nB\nc')
    expect(out).toContain('@@ -2 +2 @@')
    expect(out).toContain('-b')
    expect(out).toContain('+B')
    expect(out).not.toContain('a')
  })

  it('줄이 추가되면 + 로만 나온다', () => {
    const out = diffLines('a\nc', 'a\nb\nc')
    expect(out.split('\n').filter((l) => l.startsWith('+'))).toEqual(['+b'])
    expect(out.split('\n').filter((l) => l.startsWith('-'))).toEqual([])
  })

  it('줄이 사라지면 - 로만 나온다', () => {
    const out = diffLines('a\nb\nc', 'a\nc')
    expect(out.split('\n').filter((l) => l.startsWith('-'))).toEqual(['-b'])
  })

  it('멀리 떨어진 변경은 덩어리를 나눈다', () => {
    const prev = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const next = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'H'].join('\n')
    const heads = diffLines(prev, next)
      .split('\n')
      .filter((l) => l.startsWith('@@'))
    expect(heads).toHaveLength(2)
    expect(heads[0]).toBe('@@ -1 +1 @@')
    expect(heads[1]).toBe('@@ -8 +8 @@')
  })

  it('빈 문자열에서 시작하면 전부 추가로 본다', () => {
    expect(diffLines('', 'a\nb')).toBe('@@ -1 +1 @@\n+a\n+b')
  })

  it('1만 줄을 100ms 안에 비교한다', () => {
    const prev = Array.from({ length: 10000 }, (_, i) => `line ${i}`).join('\n')
    const next = prev.replace('line 5000', 'line 5000 changed')
    const started = Date.now()
    const out = diffLines(prev, next)
    expect(Date.now() - started).toBeLessThan(100)
    expect(out).toContain('+line 5000 changed')
  })

  it('완전히 다른 큰 문서도 블록 교체로 답한다', () => {
    const prev = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n')
    const next = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')
    const started = Date.now()
    const out = diffLines(prev, next)
    expect(Date.now() - started).toBeLessThan(200)
    expect(out.startsWith('@@ -1 +1 @@')).toBe(true)
  })
})
