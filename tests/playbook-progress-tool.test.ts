import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부른다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES, validateProgress, PROGRESS_INVALID } =
  await import('../src/main/agent/tools')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

let reported: { done: number; total: number; label?: string }[]
let ticks: number
let progress: ToolStub

beforeEach(() => {
  reported = []
  ticks = 0
  const tabs = { active: () => null, list: () => [] } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: [],
    mode: 'guard',
    finalConfirm: false,
    confirm: async () => true,
    tick: () => {
      ticks += 1
      return null
    },
    onStep: () => {},
    onProgress: (p) => reported.push(p)
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  const found = server.tools.find((t) => t.name === 'progress')
  if (!found) throw new Error('progress 도구가 등록되지 않았습니다')
  progress = found
})

describe('progress 도구 입력 검증', () => {
  it('정상 입력은 그대로 보고된다', async () => {
    const r = await progress.handler({ done: 3, total: 26, label: '티셔츠' })
    expect(r.content[0].text).toBe('ok: 3/26')
    expect(reported).toEqual([{ done: 3, total: 26, label: '티셔츠' }])
  })

  it('라벨은 없어도 된다', async () => {
    await progress.handler({ done: 0, total: 1 })
    expect(reported).toEqual([{ done: 0, total: 1 }])
  })

  it('done 이 total 보다 크면 거부한다', async () => {
    const r = await progress.handler({ done: 5, total: 3 })
    expect(r.content[0].text).toBe(PROGRESS_INVALID)
    expect(reported).toHaveLength(0)
  })

  it('음수·0건·소수는 거부한다', () => {
    expect(validateProgress(-1, 3)).toBe(PROGRESS_INVALID)
    expect(validateProgress(0, 0)).toBe(PROGRESS_INVALID)
    expect(validateProgress(1.5, 3)).toBe(PROGRESS_INVALID)
    expect(validateProgress(1, 3.5)).toBe(PROGRESS_INVALID)
  })

  it('경계값(0/N, N/N)은 통과한다', () => {
    expect(validateProgress(0, 1)).toBeNull()
    expect(validateProgress(26, 26)).toBeNull()
  })

  it('긴 라벨은 잘라서 보고한다', async () => {
    await progress.handler({ done: 1, total: 2, label: '가'.repeat(200) })
    expect(reported[0].label).toHaveLength(80)
  })

  it('도구 호출 상한(tick)을 쓰지 않는다 — 진행 표시 때문에 일할 호출이 줄면 안 된다', async () => {
    await progress.handler({ done: 1, total: 2 })
    expect(ticks).toBe(0)
  })

  it('허용 도구 목록에 들어 있다', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__progress')
  })

  it('onProgress 가 없으면 조용히 받기만 한다', async () => {
    const tabs = { active: () => null, list: () => [] } as unknown as TabManager
    const server = createSambaTools({
      tabs,
      dangerWords: [],
      mode: 'guard',
      finalConfirm: false,
      confirm: async () => true,
      tick: () => null,
      onStep: () => {}
    }) as unknown as { tools: ToolStub[] }
    const tool = server.tools.find((t) => t.name === 'progress')
    expect(tool).toBeDefined()
    if (!tool) return
    const r = await tool.handler({ done: 1, total: 2 })
    expect(r.content[0].text).toBe('ok: 1/2')
  })
})
