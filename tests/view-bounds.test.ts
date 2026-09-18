import { describe, it, expect } from 'vitest'
import { computeViewBounds } from '../src/main/browser/tab-manager'
import type { Layout } from '../src/shared/ipc'

// 렌더러가 1440x900 뷰포트에서 잰 실측값(카드 py-2.5 = 아래 10px 여백, 테두리 1px)
const reported: Layout = {
  x: 233,
  y: 101,
  width: 816,
  height: 788,
  viewportWidth: 1440,
  viewportHeight: 900
}

describe('computeViewBounds', () => {
  it('보고 시점과 창 크기가 같으면 좌표를 그대로 쓴다', () => {
    const b = computeViewBounds(reported, 1440, 900)
    expect(b.x).toBe(233)
    expect(b.y).toBe(101)
    expect(b.width).toBe(816)
    expect(b.height).toBe(788)
  })

  it('창이 줄어든 뒤 보고가 누락돼도 아래·오른쪽 여백을 유지한다', () => {
    // 1440x900 -> 1427x889 로 줄었는데 렌더러가 다시 보고하지 않은 상황
    const b = computeViewBounds(reported, 1427, 889)
    // 아래 여백 11px(패딩 10 + 테두리 1), 오른쪽 여백 391px 이 그대로 유지돼야 한다
    expect(b.y + b.height).toBe(889 - 11)
    expect(b.x + b.width).toBe(1427 - 391)
  })

  it('창이 커져도 여백을 유지한다(최대화)', () => {
    const b = computeViewBounds(reported, 1920, 1032)
    expect(b.y + b.height).toBe(1032 - 11)
    expect(b.x + b.width).toBe(1920 - 391)
  })

  it('접힌 레이아웃(browser 뷰가 아닐 때)은 0 으로 유지된다', () => {
    const b = computeViewBounds(
      { x: 0, y: 0, width: 0, height: 0, viewportWidth: 1440, viewportHeight: 900 },
      1920,
      1032
    )
    expect(b).toEqual({ x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 })
  })

  it('창이 여백보다 작아지면 음수 대신 0 크기를 돌려준다', () => {
    const b = computeViewBounds(reported, 300, 80)
    expect(b.width).toBe(0)
    expect(b.height).toBe(0)
  })
})
