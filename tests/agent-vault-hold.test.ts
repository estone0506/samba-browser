import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/ipc'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'
import type { VaultService } from '../src/main/vault/service'

// 스트림 동작을 테스트마다 갈아 끼우는 하네스(agent-stop 과 같은 방식)
let script: { delayMs: number; messages: unknown[]; throws?: string } = {
  delayMs: 0,
  messages: []
}

vi.mock('../src/main/agent/provider', async () => {
  const actual = await vi.importActual<typeof import('../src/main/agent/provider')>(
    '../src/main/agent/provider'
  )
  return {
    ...actual,
    runQuery: () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, script.delayMs))
        if (script.throws !== undefined) throw new Error(script.throws)
        for (const m of script.messages) yield m
      })()
  }
})

vi.mock('../src/main/agent/tools', () => ({
  createSambaTools: () => ({}),
  SAMBA_TOOL_NAMES: []
}))

const { AgentRunner } = await import('../src/main/agent/runner')

// 보류 토큰만 흉내내는 금고 스텁 — 잡은 수와 푼 수만 센다
function makeVault(): { vault: VaultService; held: () => number; reasons: string[] } {
  let open = 0
  const reasons: string[] = []
  const vault = {
    holdAutoLock: (reason: string) => {
      open += 1
      reasons.push(reason)
      let released = false
      return (): void => {
        if (released) return
        released = true
        open -= 1
      }
    }
  }
  return { vault: vault as unknown as VaultService, held: () => open, reasons }
}

function makeRunner(
  vault?: VaultService,
  onEvent?: (e: AgentEvent) => void
): { runner: InstanceType<typeof AgentRunner>; events: AgentEvent[] } {
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
    (e) => {
      events.push(e)
      onEvent?.(e)
    },
    vault
  )
  return { runner, events }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AgentRunner 는 실행 중 금고 자동 잠금을 보류한다', () => {
  it('정상 종료(done)에서 보류를 푼다', async () => {
    script = {
      delayMs: 0,
      messages: [{ type: 'result', subtype: 'success', is_error: false, result: '끝' }]
    }
    const { vault, held, reasons } = makeVault()
    const { runner, events } = makeRunner(vault)
    await runner.run('작업')
    expect(reasons).toEqual(['agent run'])
    expect(held()).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'done' })
  })

  it('실패 종료(failed)에서 보류를 푼다', async () => {
    script = {
      delayMs: 0,
      messages: [{ type: 'result', subtype: 'error_during_execution', errors: ['망함'] }]
    }
    const { vault, held } = makeVault()
    const { runner, events } = makeRunner(vault)
    await runner.run('작업')
    expect(held()).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'failed' })
  })

  it('중단(stopped)에서는 스트림이 끝나기 전에 곧바로 보류를 푼다', async () => {
    script = { delayMs: 60_000, messages: [] }
    const { vault, held } = makeVault()
    const { runner } = makeRunner(vault)
    void runner.run('작업')
    await tick()
    expect(held()).toBe(1)
    runner.stop()
    expect(held()).toBe(0)
  })

  it('실행 중 예외가 밖으로 튀어도 보류를 푼다', async () => {
    script = { delayMs: 0, messages: [], throws: '스트림 폭발' }
    const { vault, held } = makeVault()
    // 실패 상태를 알리는 도중 소비자가 터지면 run() 자체가 reject 된다
    const { runner } = makeRunner(vault, (e) => {
      if (e.type === 'status' && e.state === 'failed') throw new Error('소비자 폭발')
    })
    await expect(runner.run('작업')).rejects.toThrow('소비자 폭발')
    expect(held()).toBe(0)
  })

  it('연속 실행에서 보류가 쌓이지 않는다', async () => {
    script = {
      delayMs: 0,
      messages: [{ type: 'result', subtype: 'success', is_error: false, result: '끝' }]
    }
    const { vault, held, reasons } = makeVault()
    const { runner } = makeRunner(vault)
    await runner.run('첫 작업')
    await runner.run('두 번째 작업')
    expect(reasons).toHaveLength(2)
    expect(held()).toBe(0)
  })

  it('금고가 없으면(배선 전) 그대로 실행된다', async () => {
    script = {
      delayMs: 0,
      messages: [{ type: 'result', subtype: 'success', is_error: false, result: '끝' }]
    }
    const { runner, events } = makeRunner()
    await runner.run('작업')
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'done' })
  })
})
