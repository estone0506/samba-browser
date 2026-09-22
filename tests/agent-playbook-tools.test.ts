// list_playbooks·update_playbook — 절차 읽기와 확인 카드를 거친 수정.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { PlaybookDto } from '../src/shared/playbook'

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
    keypadSignals: vi.fn(async () => ({ url: '', text: '', digitButtons: 0, pinField: false })),
    snapshot: vi.fn(async () => ({ url: '', title: '', text: '', elements: [], total: 0 })),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES } = await import('../src/main/agent/tools')
const { PLAYBOOK_INSTRUCTIONS_MAX } = await import('../src/shared/playbook')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

function playbook(over: Partial<PlaybookDto> = {}): PlaybookDto {
  return {
    id: 'p1',
    name: '포이즌 소싱 주문 처리',
    triggers: ['주문처리'],
    instructions: '1. 주문서 열기\n2. 결제 직전 사람 확인',
    enabled: true,
    updatedAt: 1,
    ...over
  }
}

function build(opts: { withPlaybooks?: boolean; approve?: boolean; rows?: PlaybookDto[] } = {}): {
  tools: ToolStub[]
  confirm: ReturnType<typeof vi.fn>
  updates: Array<{ id: string; instructions: string }>
  steps: Array<{ label: string; ok: boolean }>
} {
  const rows = opts.rows ?? [playbook()]
  const updates: Array<{ id: string; instructions: string }> = []
  const steps: Array<{ label: string; ok: boolean }> = []
  const confirm = vi.fn(async () => opts.approve ?? true)
  const tabs = { active: () => null, list: () => [] } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: [],
    // full 모드에서도 확인 카드가 떠야 한다
    mode: 'full',
    finalConfirm: false,
    confirm,
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok }),
    playbooks:
      opts.withPlaybooks === false
        ? undefined
        : {
            list: () => rows,
            update: (id, instructions) => {
              updates.push({ id, instructions })
              const found = rows.find((r) => r.id === id)
              return found ? { ...found, instructions } : null
            }
          }
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, confirm, updates, steps }
}

const textOf = (r: { content: { text: string }[] }): string => r.content[0].text

beforeEach(() => vi.clearAllMocks())

describe('등록', () => {
  it('허용 도구 목록에 두 이름이 있다', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__list_playbooks')
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__update_playbook')
  })

  it('플레이북이 주입되지 않으면 도구를 내보내지 않는다', () => {
    const { tools } = build({ withPlaybooks: false })
    expect(tools.map((t) => t.name)).not.toContain('list_playbooks')
    expect(tools.map((t) => t.name)).not.toContain('update_playbook')
  })
})

describe('list_playbooks', () => {
  it('id 없이 부르면 본문 없이 이름·트리거·글자 수만 준다', async () => {
    const { tools } = build()
    const out = JSON.parse(
      textOf(await tools.find((t) => t.name === 'list_playbooks')!.handler({}))
    )
    expect(out).toEqual([
      { id: 'p1', name: '포이즌 소싱 주문 처리', triggers: ['주문처리'], enabled: true, chars: 24 }
    ])
  })

  it('id 를 주면 절차 본문을 준다', async () => {
    const { tools } = build()
    const out = JSON.parse(
      textOf(await tools.find((t) => t.name === 'list_playbooks')!.handler({ id: 'p1' }))
    )
    expect(out.instructions).toBe('1. 주문서 열기\n2. 결제 직전 사람 확인')
  })

  it('없는 id 는 거절한다', async () => {
    const { tools } = build()
    expect(
      textOf(await tools.find((t) => t.name === 'list_playbooks')!.handler({ id: 'nope' }))
    ).toMatch(/^refused/)
  })
})

describe('update_playbook', () => {
  const call = (
    tools: ToolStub[],
    args: Record<string, unknown>
  ): Promise<{ content: { text: string }[] }> =>
    tools.find((t) => t.name === 'update_playbook')!.handler(args)

  it('덧붙이기: 확인 카드에 이름과 덧붙일 글을 싣고, 승인하면 끝에 붙여 저장한다', async () => {
    const { tools, confirm, updates } = build()
    const r = await call(tools, { id: 'p1', append: '3. 장바구니 쿠폰 선택' })
    expect(textOf(r)).toMatch(/^ok: updated/)
    expect(confirm).toHaveBeenCalledTimes(1)
    const [label, kind] = confirm.mock.calls[0] as unknown as [string, string]
    expect(label).toContain('포이즌 소싱 주문 처리')
    expect(label).toContain('3. 장바구니 쿠폰 선택')
    expect(kind).toBe('danger')
    expect(updates).toEqual([
      { id: 'p1', instructions: '1. 주문서 열기\n2. 결제 직전 사람 확인\n\n3. 장바구니 쿠폰 선택' }
    ])
  })

  it('거부하면 저장하지 않는다', async () => {
    const { tools, updates } = build({ approve: false })
    const r = await call(tools, { id: 'p1', append: '악성 단계' })
    expect(textOf(r)).toBe('denied by user')
    expect(updates).toEqual([])
  })

  it('통째 교체: 카드에는 길이 변화가 실린다', async () => {
    const { tools, confirm, updates } = build()
    await call(tools, { id: 'p1', instructions: '새 절차' })
    const [label] = confirm.mock.calls[0] as unknown as [string]
    expect(label).toContain('24자 → 4자')
    expect(updates[0].instructions).toBe('새 절차')
  })

  it('append 와 instructions 를 둘 다 주거나 둘 다 빼면 거절한다', async () => {
    const { tools, confirm } = build()
    expect(textOf(await call(tools, { id: 'p1' }))).toMatch(/^refused/)
    expect(textOf(await call(tools, { id: 'p1', append: 'a', instructions: 'b' }))).toMatch(
      /^refused/
    )
    expect(confirm).not.toHaveBeenCalled()
  })

  it('빈 글·상한 초과·없는 id 는 카드도 띄우지 않고 거절한다', async () => {
    const { tools, confirm } = build()
    expect(textOf(await call(tools, { id: 'p1', append: '   ' }))).toMatch(/^refused/)
    expect(textOf(await call(tools, { id: 'p1', instructions: '' }))).toMatch(/^refused/)
    expect(
      textOf(await call(tools, { id: 'p1', append: 'x'.repeat(PLAYBOOK_INSTRUCTIONS_MAX) }))
    ).toMatch(/^refused: playbook would be/)
    expect(textOf(await call(tools, { id: 'zz', append: 'a' }))).toMatch(/^refused/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('같은 본문이면 저장하지 않는다', async () => {
    const { tools, confirm, updates } = build()
    expect(
      textOf(
        await call(tools, { id: 'p1', instructions: '1. 주문서 열기\n2. 결제 직전 사람 확인' })
      )
    ).toBe('ok: no change')
    expect(confirm).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('저장이 실패하면 error 로 알린다', async () => {
    const rows = [playbook()]
    // 목록에는 있지만 저장이 null 을 돌려주는 상황(사이에 지워진 경우)을 흉내 낸다
    const tabs = { active: () => null, list: () => [] } as unknown as TabManager
    const ctx: ToolContext = {
      tabs,
      dangerWords: [],
      mode: 'full',
      finalConfirm: false,
      confirm: vi.fn(async () => true),
      tick: () => null,
      onStep: () => {},
      playbooks: { list: () => rows, update: () => null }
    }
    const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
    const r = await call(server.tools, { id: 'p1', append: 'a' })
    expect(textOf(r)).toMatch(/^error/)
  })
})
