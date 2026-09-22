// 사이트 스크립트 — 통한 run_js 코드를 매개변수째 저장하고 run_script 한 번으로 재생한다

import { describe, it, expect, vi } from 'vitest'
import {
  SITE_SCRIPT_FAIL_LIMIT,
  SITE_SCRIPT_MAX,
  buildScriptsBlock,
  isScriptFailure,
  recordScriptRun,
  siteScriptFileSchema,
  upsertScript,
  validateScriptInput,
  type SiteScript
} from '../src/shared/site-scripts'
import { SiteScriptStore } from '../src/main/agent/site-scripts-store'
import { runSandbox } from '../src/main/agent/run-js'

const input = {
  name: 'samba_find_order',
  host: 'samba-wave.vercel.app',
  description: '상품주문번호로 주문 행을 찾아 금액·상태를 돌려준다',
  params: ['orderNo — 상품주문번호'],
  code: 'await page.type(57, args.orderNo, true); return { found: true }'
}

describe('validateScriptInput', () => {
  it('정상 입력은 통과한다', () => {
    expect(validateScriptInput(input)).toBeNull()
  })
  it('이름은 snake_case 여야 한다', () => {
    expect(validateScriptInput({ ...input, name: 'Find Order' })).toMatch(/snake_case/)
  })
  it('인자를 선언하고 args 를 읽지 않으면 거절한다(값을 코드에 박았다는 뜻)', () => {
    expect(validateScriptInput({ ...input, code: 'await page.click(3)' })).toMatch(/args/)
  })
  it('주문번호 같은 긴 숫자가 코드에 박혀 있으면 거절한다', () => {
    const code = "await page.type(57, '21315204550923299', true); return args.orderNo"
    expect(validateScriptInput({ ...input, code })).toMatch(/long number/)
  })
  it('요소 id·sleep 같은 짧은 숫자는 괜찮다', () => {
    const code = 'await page.click(1696); await sleep(4500); return args.orderNo'
    expect(validateScriptInput({ ...input, code })).toBeNull()
  })
})

describe('upsertScript / recordScriptRun', () => {
  it('같은 이름은 갈아 끼우고 통계를 새로 시작한다', () => {
    let list = upsertScript([], input, 1)
    list = recordScriptRun(list, input.name, true, 2)
    expect(list[0].runs).toBe(1)
    list = upsertScript(list, { ...input, description: '고친 판' }, 3)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ description: '고친 판', runs: 0, fails: 0, createdAt: 1 })
  })
  it('상한을 넘으면 오래 안 쓴 것부터 버린다', () => {
    let list: SiteScript[] = []
    for (let i = 0; i < SITE_SCRIPT_MAX + 3; i += 1)
      list = upsertScript(list, { ...input, name: `script_${i}` }, i)
    expect(list).toHaveLength(SITE_SCRIPT_MAX)
    expect(list.some((s) => s.name === 'script_0')).toBe(false)
  })
  it('성공하면 연속 실패를 지운다', () => {
    let list = upsertScript([], input, 1)
    list = recordScriptRun(list, input.name, false, 2)
    list = recordScriptRun(list, input.name, false, 3)
    expect(list[0].fails).toBe(2)
    list = recordScriptRun(list, input.name, true, 4)
    expect(list[0]).toMatchObject({ fails: 0, runs: 1 })
  })
})

describe('buildScriptsBlock', () => {
  it('이름·설명·인자만 싣고 코드는 싣지 않는다', () => {
    const block = buildScriptsBlock(upsertScript([], input, 1))
    expect(block).toContain('samba_find_order')
    expect(block).toContain('orderNo')
    expect(block).not.toContain('page.type')
  })
  it('연속으로 실패한 스크립트는 목록에서 빠진다', () => {
    let list = upsertScript([], input, 1)
    for (let i = 0; i < SITE_SCRIPT_FAIL_LIMIT; i += 1)
      list = recordScriptRun(list, input.name, false, 2 + i)
    expect(buildScriptsBlock(list)).toBe('')
  })
  it('저장된 것이 없으면 빈 문자열', () => {
    expect(buildScriptsBlock([])).toBe('')
  })
})

describe('파일 스키마', () => {
  it('깨진 항목만 버리고 나머지는 살린다', () => {
    const good = upsertScript([], input, 1)[0]
    expect(siteScriptFileSchema.parse([good, { name: 'Bad Name' }, 7])).toEqual([good])
    expect(siteScriptFileSchema.parse('nope')).toEqual([])
  })
})

describe('SiteScriptStore', () => {
  it('저장·조회·통계·삭제', () => {
    const store = new SiteScriptStore(null, () => 100)
    expect(store.save(input)).toBe('saved: samba_find_order')
    expect(store.save(input)).toBe('updated: samba_find_order')
    expect(store.save({ ...input, name: 'X' })).toMatch(/^refused/)
    store.ran(input.name, true)
    expect(store.find(input.name)?.runs).toBe(1)
    expect(store.remove(input.name)).toBe(true)
    expect(store.list()).toEqual([])
  })
})

describe('run_script 실행 — 샌드박스가 args 를 받는다', () => {
  it('args 값이 코드에 전달되고 다리 호출에 실린다', async () => {
    const bridge = vi.fn(async () => 'ok')
    const out = await runSandbox(input.code, bridge, { args: { orderNo: 'A-1' } })
    expect(bridge).toHaveBeenCalledWith('page.type', [57, 'A-1', true])
    expect(out).toBe('{"found":true}')
  })
  it('run_js 에서는 args 가 빈 객체다', async () => {
    expect(await runSandbox('return Object.keys(args).length', vi.fn())).toBe('0')
  })
  it('실패 판정: Error:/refused: 로 시작하는 줄이 있으면 실패', async () => {
    const out = await runSandbox('throw new Error("행을 못 찾음")', vi.fn())
    expect(isScriptFailure(out)).toBe(true)
    expect(isScriptFailure('{"found":true}')).toBe(false)
  })
})
