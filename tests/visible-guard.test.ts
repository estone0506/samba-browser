import { describe, it, expect } from 'vitest'
import {
  isHumanMouseInput,
  openInBackground,
  pickWorkingTabId,
  shouldHoldVisible
} from '../src/main/browser/visible-guard'
import {
  HUMAN_BUSY_MS,
  humanBusyInWindow,
  lastHumanInWindowAt,
  markHumanInWindow
} from '../src/main/browser/human-activity'

describe('shouldHoldVisible — 사람이 쓰는 창의 보이는 탭·포커스를 자동화가 빼앗지 않는다', () => {
  const now = 1_000_000

  it('자동화가 아니면(사용자가 탭을 누름) 언제나 전환한다', () => {
    expect(shouldHoldVisible(false, now - 1_000, now)).toBe(false)
  })

  it('자동화인데 사람 입력 기록이 없으면 전환한다', () => {
    expect(shouldHoldVisible(true, undefined, now)).toBe(false)
  })

  it('자동화인데 사람이 방금 입력했으면 전환하지 않는다', () => {
    expect(shouldHoldVisible(true, now - 1_000, now)).toBe(true)
  })

  it('경계: HUMAN_BUSY_MS 직전은 막고, 정확히 지나면 전환한다', () => {
    expect(shouldHoldVisible(true, now - HUMAN_BUSY_MS + 1, now)).toBe(true)
    expect(shouldHoldVisible(true, now - HUMAN_BUSY_MS, now)).toBe(false)
  })

  it('판정 시간은 human-activity 의 HUMAN_BUSY_MS(60초)와 같다', () => {
    expect(HUMAN_BUSY_MS).toBe(60_000)
    expect(shouldHoldVisible(true, now - 59_999, now)).toBe(true)
  })

  it('busyMs 를 따로 줄 수 있다', () => {
    expect(shouldHoldVisible(true, now - 5_000, now, 3_000)).toBe(false)
  })
})

describe('pickWorkingTabId — 자동화 대상 탭 표식', () => {
  it('표식이 없으면 보이는 탭', () => {
    expect(pickWorkingTabId(null, ['a', 'b'], 'a')).toBe('a')
  })

  it('표식이 살아 있는 탭을 가리키면 그 탭(보이는 탭과 달라도)', () => {
    expect(pickWorkingTabId('b', ['a', 'b'], 'a')).toBe('b')
  })

  it('표식이 가리키던 탭이 닫혔으면 보이는 탭으로 돌아간다', () => {
    expect(pickWorkingTabId('gone', ['a'], 'a')).toBe('a')
  })

  it('탭이 하나도 없으면 null', () => {
    expect(pickWorkingTabId(null, [], null)).toBeNull()
  })
})

describe('isHumanMouseInput — 마우스는 누름만 사람 입력으로 센다', () => {
  it('mouseDown 만 true', () => {
    expect(isHumanMouseInput('mouseDown')).toBe(true)
    const others = ['mouseUp', 'mouseMove', 'mouseWheel', 'mouseEnter', 'mouseLeave', 'contextMenu']
    for (const t of others) {
      expect(isHumanMouseInput(t)).toBe(false)
    }
  })
})

describe('openInBackground — 보이지 않는 탭이 연 새 탭은 뒤에서 연다', () => {
  it('보이는 탭이 연 새 탭은 앞으로(크롬과 같다)', () => {
    expect(openInBackground('a', 'a')).toBe(false)
  })

  it('뒤 탭(자동화가 조작하는 탭)이 연 새 탭은 뒤에서', () => {
    expect(openInBackground('b', 'a')).toBe(true)
  })

  it('보이는 탭이 없으면 앞으로', () => {
    expect(openInBackground('b', null)).toBe(false)
  })
})

describe('창 단위 사람 입력 기록', () => {
  it('창에 입력을 기록하면 그 창만 바쁘다', () => {
    const winA = {}
    const winB = {}
    const now = 5_000_000
    markHumanInWindow(winA, now)
    expect(lastHumanInWindowAt(winA)).toBe(now)
    expect(lastHumanInWindowAt(winB)).toBeUndefined()
    expect(humanBusyInWindow(winA, now + 1_000)).toBe(true)
    expect(humanBusyInWindow(winB, now + 1_000)).toBe(false)
    expect(humanBusyInWindow(winA, now + HUMAN_BUSY_MS)).toBe(false)
  })
})
