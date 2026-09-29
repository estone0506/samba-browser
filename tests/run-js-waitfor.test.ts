// run_js page.waitFor — 글자가 보이면 바로, 안 보이면 제한 시간 뒤 false
import { describe, it, expect } from 'vitest'
import { runSandbox } from '../src/main/agent/run-js'

describe('page.waitFor', () => {
  it('글자가 뜨면 기다리지 않고 true, 끝내 안 뜨면 false', async () => {
    let calls = 0
    const bridge = async (name: string): Promise<unknown> => {
      if (name === 'page.get') {
        calls += 1
        return { tree: calls >= 2 ? '[1] button "주문서"' : '', diff: '', total: 0, elements: 0 }
      }
      return 'ok'
    }
    expect(await runSandbox('return await page.waitFor("주문서", 3000)', bridge)).toContain('true')
    expect(await runSandbox('return await page.waitFor(/결제완료/, 300)', bridge)).toContain('false')
  })
})
