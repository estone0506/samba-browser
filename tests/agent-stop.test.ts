import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/ipc'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'

// 스트림이 늦게 끝나는 상황(api_retry 백오프)을 흉내내는 하네스.
// 스트림 메시지와 지연은 테스트가 매번 주입한다
let script: { delayMs: number; messages: unknown[] } = { delayMs: 60_000, messages: [] }

vi.mock('../src/main/agent/provider', async () => {
  const actual = await vi.importActual<typeof import('../src/main/agent/provider')>(
    '../src/main/agent/provider'
  )
  return {
    ...actual,
    runQuery: () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, script.delayMs))
        for (const m of script.messages) yield m
      })()
  }
})

vi.mock('../src/main/agent/tools', () => ({
  createSambaTools: () => ({}),
  SAMBA_TOOL_NAMES: []
}))

const { AgentRunner } = await import('../src/main/agent/runner')

function makeRunner(): { runner: InstanceType<typeof AgentRunner>; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const settings = {
    get: () => ({
      model: 'sonnet',
      language: 'ko',
      panelWidth: 380,
      lastUrl: '',
      dangerWords: [],
      maxToolCalls: 40
    })
  }
  const runner = new AgentRunner(
    {} as unknown as TabManager,
    settings as unknown as SettingsStore,
    (e) => events.push(e)
  )
  return { runner, events }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AgentRunner.stop', () => {
  it('멈춘 스트림에서도 즉시 stopped 를 보내고 재실행을 받는다', async () => {
    script = { delayMs: 60_000, messages: [] }
    const { runner, events } = makeRunner()
    void runner.run('첫 작업')
    await tick()
    runner.stop()
    await tick()
    expect(events).toEqual([
      { type: 'status', state: 'running', toolCalls: 0 },
      { type: 'status', state: 'stopped' }
    ])
    // 이전 스트림이 아직 안 끝났어도 새 작업을 받아야 한다
    void runner.run('두 번째 작업')
    await tick()
    expect(events[2]).toEqual({ type: 'status', state: 'running', toolCalls: 0 })
  })

  it('중단된 이전 스트림의 늦은 이벤트는 버린다', async () => {
    script = {
      delayMs: 20,
      messages: [
        { type: 'assistant', message: { content: [{ type: 'text', text: '늦은 답변' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '늦은 결과' }
      ]
    }
    const { runner, events } = makeRunner()
    void runner.run('첫 작업')
    await tick()
    runner.stop()
    await tick(60)
    expect(events).toEqual([
      { type: 'status', state: 'running', toolCalls: 0 },
      { type: 'status', state: 'stopped' }
    ])
  })
})

describe('AgentRunner 텍스트 중복', () => {
  it('같은 문단이 두 번 와도 한 번만 보낸다', async () => {
    script = {
      delayMs: 0,
      messages: [
        { type: 'assistant', message: { content: [{ type: 'text', text: '결과입니다.' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '결과입니다.' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '결과입니다.' }
      ]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    const texts = events.filter((e) => e.type === 'text')
    expect(texts).toEqual([{ type: 'text', text: '결과입니다.' }])
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'done' })
  })

  it('assistant 텍스트가 없으면 결과 문자열을 대신 보여준다', async () => {
    script = {
      delayMs: 0,
      messages: [{ type: 'result', subtype: 'success', is_error: false, result: '최종 요약' }]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '최종 요약' }])
  })

  it('재시도 가능한 api_retry 는 progress 로 알린다', async () => {
    script = {
      delayMs: 0,
      messages: [
        {
          type: 'system',
          subtype: 'api_retry',
          error: 'rate_limit',
          error_status: 429,
          attempt: 3
        },
        { type: 'result', subtype: 'success', is_error: false, result: '끝' }
      ]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    expect(events[1]).toEqual({
      type: 'progress',
      kind: 'apiRetry',
      attempt: 3,
      reason: 'rate_limit'
    })
  })

  it('모델이 쓴 결과 문구의 login 은 인증 오류로 오분류하지 않는다', async () => {
    script = {
      delayMs: 0,
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Could not finish: the login page kept redirecting'
        }
      ]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    const last = events.at(-1)
    expect(last).toMatchObject({ type: 'status', state: 'failed' })
    expect(last?.type === 'status' && last.message?.startsWith('auth:')).toBe(false)
  })

  it('회복 불가 api_retry 는 즉시 실패로 끝낸다', async () => {
    script = {
      delayMs: 0,
      messages: [
        {
          type: 'system',
          subtype: 'api_retry',
          error: 'authentication_failed',
          error_status: 401,
          attempt: 1
        }
      ]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      state: 'failed',
      message: 'auth:missing'
    })
  })
})
