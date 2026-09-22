// 도구 제한 시간 — 사람을 기다리는 동안(확인 카드·키패드 넘김)은 시간을 세지 않는다

import { describe, it, expect } from 'vitest'
import { withToolTimeout } from '../src/main/agent/tools'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('withToolTimeout', () => {
  it('제한 시간 안에 끝나면 결과를 그대로 돌려준다', async () => {
    expect(await withToolTimeout(Promise.resolve('ok'), 50, () => false, 5)).toBe('ok')
  })

  it('페이지가 응답하지 않으면 제한 시간 뒤 안내 문구로 끝난다', async () => {
    const r = await withToolTimeout(sleep(500).then(() => 'late'), 40, () => false, 5)
    expect(r).toMatch(/did not respond/)
  })

  it('사람을 기다리는 동안은 제한 시간을 넘겨도 끊지 않는다', async () => {
    let waiting = true
    const work = sleep(150).then(() => {
      waiting = false
      return 'user pressed continue'
    })
    expect(await withToolTimeout(work, 40, () => waiting, 5)).toBe('user pressed continue')
  })

  it('사람 대기가 끝난 뒤부터는 다시 시간을 센다', async () => {
    let waiting = true
    setTimeout(() => (waiting = false), 60)
    const r = await withToolTimeout(sleep(1000).then(() => 'late'), 40, () => waiting, 5)
    expect(r).toMatch(/did not respond/)
  })
})
