// 예비 프로세스 풀 — 미리 띄워 두기·꺼내 쓰기·설정 변경 시 버리기·놀면 닫기

import { describe, it, expect } from 'vitest'
import { WarmPool } from '../src/main/agent/warm'

interface FakeSpare {
  id: number
}

/** 가짜 타이머 — 만료를 테스트가 직접 굴린다 */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
  fire: () => void
} {
  const timers = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (fn) => {
      const id = next++
      timers.set(id, fn)
      return id
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    },
    fire: () => {
      const all = Array.from(timers.values())
      timers.clear()
      for (const fn of all) fn()
    }
  }
}

function setup(size = 2): {
  pool: WarmPool<FakeSpare>
  closed: number[]
  started: () => number
  start: () => Promise<FakeSpare | null>
  fire: () => void
} {
  const closed: number[] = []
  const timers = fakeTimers()
  let count = 0
  const pool = new WarmPool<FakeSpare>({
    close: (s) => closed.push(s.id),
    size,
    idleMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  return {
    pool,
    closed,
    started: () => count,
    start: async () => ({ id: ++count }),
    fire: timers.fire
  }
}

describe('예비 프로세스 풀', () => {
  it('처음에는 꺼낼 것이 없다(호출부는 평소 경로로 돈다)', () => {
    const { pool } = setup()
    expect(pool.claim('m')).toBeNull()
  })

  it('미리 띄워 둔 만큼만 준비하고, 꺼내 쓰면 다시 채운다', async () => {
    const { pool, start, started } = setup(2)
    pool.prewarm('m', start)
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(2)
    expect(started()).toBe(2)

    const one = pool.claim('m')
    expect(one).not.toBeNull()
    expect(pool.ready()).toBe(1)

    pool.prewarm('m', start)
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(2)
    expect(started()).toBe(3)
  })

  it('설정(모델)이 바뀌면 들고 있던 예비를 버린다', async () => {
    const { pool, start, closed } = setup(1)
    pool.prewarm('haiku', start)
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(1)

    expect(pool.claim('sonnet')).toBeNull()
    expect(closed).toEqual([1])
    expect(pool.ready()).toBe(0)
  })

  it('띄우는 중에 설정이 바뀌면 다 뜬 예비를 그냥 닫는다', async () => {
    const { pool, start, closed } = setup(1)
    pool.prewarm('haiku', start)
    pool.claim('sonnet')
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(0)
    expect(closed).toEqual([1])
  })

  it('띄우기에 실패해도 조용히 넘어가고 다음에 다시 시도한다', async () => {
    const closed: number[] = []
    const pool = new WarmPool<FakeSpare>({ close: (s) => closed.push(s.id), size: 1 })
    pool.prewarm('m', async () => null)
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(0)

    pool.prewarm('m', async () => ({ id: 7 }))
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(1)
  })

  it('던지는 start 도 풀을 망가뜨리지 않는다', async () => {
    const pool = new WarmPool<FakeSpare>({ close: () => undefined, size: 1 })
    pool.prewarm('m', async () => {
      throw new Error('spawn 실패')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(0)
    pool.prewarm('m', async () => ({ id: 1 }))
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(1)
  })

  it('오래 놀고 있으면 닫아서 프로세스를 들고 있지 않는다', async () => {
    const { pool, start, closed, fire } = setup(2)
    pool.prewarm('m', start)
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.ready()).toBe(2)
    fire()
    expect(pool.ready()).toBe(0)
    expect(closed).toEqual([1, 2])
  })

  it('정리하면 남은 예비를 전부 닫고 더는 내주지 않는다', async () => {
    const { pool, start, closed } = setup(2)
    pool.prewarm('m', start)
    await Promise.resolve()
    await Promise.resolve()
    pool.dispose()
    expect(closed).toHaveLength(2)
    expect(pool.claim('m')).toBeNull()
    pool.prewarm('m', start)
    await Promise.resolve()
    expect(pool.ready()).toBe(0)
  })
})
