// 자동 학습 — 실행이 끝나면 통한 run_js 코드를 되돌려 주고 재생용 스크립트로 저장하게 한다
import { describe, it, expect } from 'vitest'
import {
  buildLearnPrompt,
  LEARN_PROMPT_PREFIX,
  shouldLearn,
  type LearnedRunJs
} from '../src/main/agent/learn'

const run = (code: string, ok = true, clicked: string[] = []): LearnedRunJs => ({
  code,
  ok,
  url: 'https://www.musinsa.com/order/order-form',
  clicked
})

describe('shouldLearn', () => {
  it('통한 run_js 가 둘 이상이면 배운다 — 실패한 것은 세지 않는다', () => {
    expect(shouldLearn('주문처리해', [run('a'), run('b')])).toBe(true)
    expect(shouldLearn('주문처리해', [run('a'), run('b', false)])).toBe(false)
  })

  it('학습 턴 자신은 다시 학습을 부르지 않는다', () => {
    expect(shouldLearn(`${LEARN_PROMPT_PREFIX} …`, [run('a'), run('b')])).toBe(false)
  })
})

describe('buildLearnPrompt', () => {
  const text = buildLearnPrompt({
    userPrompt: '734228144586785 주문처리해',
    runs: [
      run('await page.click(47); await sleep(1500)', true, ['47=구매하기']),
      run('await page.click(9)', false),
      run('x'.repeat(3000))
    ],
    steps: [
      { label: '탭 전환', ok: true },
      { label: '코드 실행: await page.click(9)', ok: false }
    ],
    savedScripts: [{ name: 'samba_find_order', description: '주문번호로 행을 찾는다' }]
  })

  it('학습 머리로 시작하고, 번호로 누른 요소의 글자를 함께 준다', () => {
    expect(text.startsWith(LEARN_PROMPT_PREFIX)).toBe(true)
    expect(text).toContain('47=구매하기')
    expect(text).toContain('page.clickText')
  })

  it('실패한 코드는 빼고, 긴 코드는 자른다', () => {
    // 통한 코드는 둘뿐이다(#1, #2) — 실패한 것은 번호를 받지 못한다
    expect(text).toContain('--- #2')
    expect(text).not.toContain('--- #3')
    expect(text).toContain('…(잘림)')
    expect(text.length).toBeLessThan(6000)
  })

  it('이미 저장된 스크립트 이름을 알려 같은 이름으로 고쳐 저장하게 한다', () => {
    expect(text).toContain('samba_find_order')
  })

  it('저장만 시킨다 — 주문·결제 버튼을 누르지 말라고 못박는다', () => {
    expect(text).toContain('지금은 저장만 한다')
  })
})
