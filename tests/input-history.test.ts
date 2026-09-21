// 채팅 입력 이력 — ↑/↓ 로 이전에 보낸 문장을 다시 꺼낸다

import { describe, it, expect } from 'vitest'
import {
  INPUT_HISTORY_MAX,
  addToHistory,
  draftCursor,
  stepHistory
} from '../src/renderer/src/lib/input-history'

describe('addToHistory', () => {
  it('빈 문장과 바로 앞과 같은 문장은 넣지 않는다', () => {
    expect(addToHistory(['a'], '  ')).toEqual(['a'])
    expect(addToHistory(['a'], 'a')).toEqual(['a'])
    expect(addToHistory(['a'], ' b ')).toEqual(['a', 'b'])
  })
  it('상한을 넘으면 오래된 것부터 버린다', () => {
    let list: string[] = []
    for (let i = 0; i < INPUT_HISTORY_MAX + 5; i += 1) list = addToHistory(list, `m${i}`)
    expect(list).toHaveLength(INPUT_HISTORY_MAX)
    expect(list[0]).toBe('m5')
  })
})

describe('stepHistory', () => {
  const list = ['첫째', '둘째', '셋째']

  it('↑ 는 최근 것부터 거슬러 올라가고, 맨 위에서는 더 움직이지 않는다', () => {
    let step = stepHistory(list, draftCursor(list), 'older', '쓰던 글')!
    expect(step.value).toBe('셋째')
    step = stepHistory(list, step.cursor, 'older', step.value)!
    expect(step.value).toBe('둘째')
    step = stepHistory(list, step.cursor, 'older', step.value)!
    expect(step.value).toBe('첫째')
    expect(stepHistory(list, step.cursor, 'older', step.value)).toBeNull()
  })

  it('↓ 로 끝까지 내려오면 쓰던 글을 되돌려 준다', () => {
    const up = stepHistory(list, draftCursor(list), 'older', '쓰던 글')!
    const down = stepHistory(list, up.cursor, 'newer', up.value)!
    expect(down.value).toBe('쓰던 글')
    expect(down.cursor.index).toBe(list.length)
    expect(stepHistory(list, down.cursor, 'newer', down.value)).toBeNull()
  })

  it('이력이 없으면 키 입력을 그대로 흘려보낸다', () => {
    expect(stepHistory([], draftCursor([]), 'older', '')).toBeNull()
  })
})
