// 뒤에서 도는 자동화 탭의 층(z-order) 규칙 회귀 테스트(c7d1e5a 회귀: 창에 붙지 않은 탭은 뷰포트가 0)
import { describe, it, expect } from 'vitest'
import { splitBehind, stackOrder } from '../src/main/browser/behind-views'

const alive = (...ids: string[]): Set<string> => new Set(ids)

describe('stackOrder — 뒤 탭은 모두 보이는 탭 아래', () => {
  it('뒤 탭을 붙인 순서대로 아래에, 보이는 탭을 맨 위에 둔다', () => {
    expect(stackOrder('v', ['a', 'b'])).toEqual(['a', 'b', 'v'])
  })

  it('보이는 탭이 뒤 목록에 섞여 있어도 맨 위에 한 번만', () => {
    expect(stackOrder('a', ['a', 'b', 'b'])).toEqual(['b', 'a'])
  })

  it('보이는 탭이 없으면 뒤 탭만', () => {
    expect(stackOrder(null, ['a'])).toEqual(['a'])
  })
})

describe('splitBehind — 계속 붙여 둘 뒤 탭', () => {
  it('자동화 대상과 레인 탭은 남기고, 표식이 옮겨 간 옛 탭은 뗀다', () => {
    const r = splitBehind({
      behind: ['old', 'target', 'lane'],
      activeId: 'v',
      automationId: 'target',
      laneIds: new Set(['lane']),
      alive: alive('v', 'old', 'target', 'lane')
    })
    expect(r.keep).toEqual(['target', 'lane'])
    expect(r.drop).toEqual(['old'])
  })

  it('보이는 탭이 된 뒤 탭은 뒤 목록에서 빠진다(스로틀링 복원 대상)', () => {
    const r = splitBehind({
      behind: ['target'],
      activeId: 'target',
      automationId: 'target',
      laneIds: new Set(),
      alive: alive('target')
    })
    expect(r.keep).toEqual([])
    expect(r.drop).toEqual(['target'])
  })

  it('닫힌 탭·중복은 남기지 않는다', () => {
    const r = splitBehind({
      behind: ['lane', 'lane', 'gone'],
      activeId: 'v',
      automationId: 'gone',
      laneIds: new Set(['lane']),
      alive: alive('v', 'lane')
    })
    expect(r.keep).toEqual(['lane'])
    expect(r.drop).toEqual(['gone'])
  })
})
