import { describe, it, expect, vi } from 'vitest'
import {
  runJsLabel,
  runSandbox,
  shortStack,
  truncateOutput,
  RUN_JS_MAX_CODE,
  RUN_JS_TOO_LONG,
  type RunJsBridge
} from '../src/main/agent/run-js'

// 아무것도 하지 않는 다리(샌드박스 격리만 볼 때)
const noBridge: RunJsBridge = async () => 'ok'

describe('run_js 샌드박스 격리', () => {
  it('require 에 닿을 수 없다', async () => {
    const out = await runSandbox(
      "return typeof require === 'undefined' ? 'none' : 'leaked'",
      noBridge
    )
    expect(out).toBe('none')
  })

  it('require 를 부르면 오류 문자열로 돌아온다', async () => {
    const out = await runSandbox("return require('node:fs').readFileSync('x')", noBridge)
    expect(out.startsWith('Error: ')).toBe(true)
    expect(out).toContain('require')
  })

  it('process 에 닿을 수 없다', async () => {
    const out = await runSandbox('return process.env.HOME', noBridge)
    expect(out.startsWith('Error: ')).toBe(true)
  })

  it('globalThis 는 지워져 있다', async () => {
    const out = await runSandbox('return globalThis', noBridge)
    expect(out.startsWith('Error: ')).toBe(true)
    expect(out).toContain('globalThis')
  })

  it('함수 생성자를 타고 호스트로 나갈 수 없다', async () => {
    const out = await runSandbox(
      "return (page.click.constructor('return typeof process')())",
      noBridge
    )
    expect(out).toBe('undefined')
  })

  it('동기 무한 루프는 시간 제한에 걸린다', async () => {
    const out = await runSandbox('while (true) {}', noBridge)
    expect(out.startsWith('Error: ')).toBe(true)
  }, 30000)

  it('문법 오류는 Error 문자열로 돌아온다', async () => {
    const out = await runSandbox('const = =', noBridge)
    expect(out.startsWith('Error: ')).toBe(true)
  })

  it('스택은 두 줄까지만 담는다', () => {
    expect(shortStack('a\nb\nc\nd').split('\n')).toHaveLength(2)
  })
})

describe('run_js 결과 만들기', () => {
  it('log 출력과 반환값을 합친다', async () => {
    const out = await runSandbox("log('첫줄'); log('둘째줄'); return '끝'", noBridge)
    expect(out).toBe('첫줄\n둘째줄\n끝')
  })

  it('객체 반환값은 JSON 으로 돌려준다', async () => {
    expect(await runSandbox('return { a: 1 }', noBridge)).toBe('{"a":1}')
  })

  it('코드가 상한보다 길면 실행하지 않는다', async () => {
    const called = vi.fn(noBridge)
    expect(await runSandbox('x'.repeat(RUN_JS_MAX_CODE + 1), called)).toBe(RUN_JS_TOO_LONG)
    expect(called).not.toHaveBeenCalled()
  })

  it('긴 결과는 앞뒤를 남기고 가운데를 자른다', () => {
    const out = truncateOutput('x'.repeat(500), 100)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('characters cut')
  })

  it('진행 라벨은 첫 줄 40자', () => {
    expect(runJsLabel('\nconst s = await page.get()\nawait page.click(3)')).toBe(
      '코드 실행: const s = await page.get()'
    )
    expect(runJsLabel('a'.repeat(80))).toHaveLength('코드 실행: '.length + 40)
  })
})

describe('run_js 다리(API) 호출', () => {
  it('page/tabs/sleep 호출이 다리로 이름과 인자를 넘긴다', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const bridge: RunJsBridge = async (name, args) => {
      calls.push({ name, args })
      if (name === 'page.get') return { tree: 'T', diff: 'D', total: 3, elements: 3 }
      return 'ok'
    }
    const out = await runSandbox(
      [
        "const s = await page.get({ selector: '#a', interactive: true })",
        'log(s.diff)',
        "await page.click(7, '장바구니')",
        "await page.type(9, 'hello', true)",
        'await sleep(5)',
        'const list = await tabs.list()',
        'return s.tree'
      ].join('\n'),
      bridge
    )
    expect(out).toBe('D\nT')
    expect(calls.map((c) => c.name)).toEqual([
      'page.get',
      'page.click',
      'page.type',
      'sleep',
      'tabs.list'
    ])
    expect(calls[0].args[0]).toEqual({ selector: '#a', interactive: true })
    expect(calls[2].args).toEqual([9, 'hello', true])
  })

  it('다리가 던지면 샌드박스 안에서 오류가 된다', async () => {
    const bridge: RunJsBridge = async () => {
      throw new Error('tool call limit (40) reached. Call done with what you have.')
    }
    const out = await runSandbox('await page.click(1)', bridge)
    expect(out).toContain('tool call limit (40) reached')
  })

  it('다리 결과는 JSON 을 거치므로 호스트 객체가 새지 않는다', async () => {
    const bridge: RunJsBridge = async () => ({ tree: 'x' })
    const out = await runSandbox(
      "const s = await page.get(); return s.constructor === Object ? 'in-context' : 'leaked'",
      bridge
    )
    expect(out).toBe('in-context')
  })
})
