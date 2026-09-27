// 레인 없는 세션의 탭 목록 — 레인이 연 탭·팝업에 lane 이름이 붙는다(숨기지는 않는다)
import { describe, it, expect } from 'vitest'
import { labelLaneTargets, newLaneState, type LaneState } from '../src/main/agent/lane-tabs'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { AgentTarget } from '../src/main/browser/targets'

function fakeTabs(targets: AgentTarget[]): TabManager {
  return { listTargets: () => targets, list: () => [] } as unknown as TabManager
}

describe('labelLaneTargets', () => {
  it('레인 탭과 그 팝업에만 lane 을 붙이고 목록은 그대로 둔다', () => {
    const targets: AgentTarget[] = [
      { id: 'main', kind: 'tab', title: '', url: 'https://a/order/1', active: true },
      { id: 'fp', kind: 'tab', title: '', url: 'https://b/order/2', active: false },
      { id: 'pop', kind: 'popup', title: '', url: 'https://pay', openerId: 'fp', active: false }
    ]
    const st: LaneState = newLaneState()
    st.owned.add('fp')
    const view = labelLaneTargets(fakeTabs(targets), new Map([['fp', st]]))
    const out = view.listTargets()
    expect(out.map((t) => t.id)).toEqual(['main', 'fp', 'pop'])
    expect(out[0].lane).toBeUndefined()
    expect(out[1].lane).toBe('fp')
    expect(out[2].lane).toBe('fp')
  })

  it('레인이 없으면 원래 목록 그대로', () => {
    const targets: AgentTarget[] = [{ id: 'x', kind: 'tab', title: '', url: 'u', active: true }]
    expect(labelLaneTargets(fakeTabs(targets), new Map()).listTargets()).toEqual(targets)
  })
})
