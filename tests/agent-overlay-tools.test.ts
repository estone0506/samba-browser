import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { PageOverlay, PageSnapshot } from '../src/shared/snapshot'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부를 수 있게 한다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const emptySnapshot: PageSnapshot = {
  url: 'https://www.musinsa.com/products/1',
  title: '상품',
  text: '상품 페이지',
  elements: [{ id: 7, tag: 'button', role: 'button', text: '구매하기', isSecret: false }],
  total: 1
}

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    keypadSignals: vi.fn(async () => ({
      url: 'https://www.musinsa.com/products/1',
      text: '',
      digitButtons: 0,
      pinField: false
    })),
    snapshot: vi.fn(),
    overlays: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, PAYMENT_KEYPAD_REFUSAL } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')
const { secretKeypadGate } = await import('../src/main/agent/secret-page')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://www.musinsa.com/products/1' } },
  profile: 'default',
  mobile: false
}

function build(mode: ToolContext['mode'] = 'guard'): ToolStub[] {
  const tabs = {
    active: () => fakeTab,
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode,
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: () => {}
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return server.tools
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const run = async (t: ToolStub, args: Record<string, unknown> = {}): Promise<string> =>
  (await t.handler(args)).content[0].text

function overlay(over: Partial<PageOverlay> = {}): PageOverlay {
  return { id: 3, label: '브랜드 공지', closeIds: [12, 13], sensitive: false, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 키패드 판정은 탭별로 500ms 캐시된다 — 테스트끼리 섞이지 않게 비운다
  secretKeypadGate.clear()
  pageBridge.snapshot.mockResolvedValue(emptySnapshot)
  pageBridge.overlays.mockResolvedValue([])
  pageBridge.click.mockResolvedValue('ok')
  pageBridge.keypadSignals.mockResolvedValue({
    url: 'https://www.musinsa.com/products/1',
    text: '',
    digitButtons: 0,
    pinField: false
  })
})

describe('get_page · find_elements 앞머리의 OVERLAY 한 줄', () => {
  it('레이어가 있으면 닫기 id 와 함께 맨 앞에 알린다', async () => {
    pageBridge.overlays.mockResolvedValue([overlay()])
    const out = await run(get(build(), 'get_page'))
    expect(out.split('\n')[0]).toBe(
      'OVERLAY: "브랜드 공지" is covering the page - close ids: [12, 13]'
    )
    expect(out).toContain('구매하기')
  })

  it('find_elements 에도 같은 줄이 붙는다', async () => {
    pageBridge.overlays.mockResolvedValue([overlay()])
    const out = await run(get(build(), 'find_elements'), { query: '구매' })
    expect(out.split('\n')[0]).toContain('OVERLAY: "브랜드 공지"')
  })

  it('결제·로그인 모달이면 닫지 말라고 알린다', async () => {
    pageBridge.overlays.mockResolvedValue([
      overlay({ label: '결제 비밀번호', closeIds: [], sensitive: true })
    ])
    const out = await run(get(build(), 'get_page'))
    expect(out.split('\n')[0]).toContain('do NOT dismiss it')
  })

  it('레이어가 없으면 아무 줄도 붙지 않는다', async () => {
    const out = await run(get(build(), 'get_page'))
    expect(out.startsWith('URL:')).toBe(true)
  })

  it('레이어 조회가 실패해도 페이지 읽기는 계속된다', async () => {
    pageBridge.overlays.mockRejectedValue(new Error('page is gone'))
    const out = await run(get(build(), 'get_page'))
    expect(out.startsWith('URL:')).toBe(true)
  })
})

describe('dismiss_overlay', () => {
  it('레이어가 없으면 알리고 아무것도 누르지 않는다', async () => {
    const out = await run(get(build(), 'dismiss_overlay'))
    expect(out).toContain('no overlay')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('비민감 레이어의 첫 닫기 후보를 순서대로 최대 3개 누른다', async () => {
    const list = [
      overlay({ label: '공지1', closeIds: [11, 19] }),
      overlay({ label: '공지2', closeIds: [21] }),
      overlay({ label: '공지3', closeIds: [31] }),
      overlay({ label: '공지4', closeIds: [41] })
    ]
    pageBridge.overlays.mockResolvedValueOnce(list).mockResolvedValueOnce([list[3]])
    const out = await run(get(build(), 'dismiss_overlay'))
    // 레이어마다 '첫' 후보만, 위에서부터 3개까지
    expect(pageBridge.click.mock.calls.map((c) => c[1])).toEqual([11, 21, 31])
    expect(out).toContain('dismissed 3')
    expect(out).toContain('overlays left: 1')
  })

  it('민감 레이어는 건드리지 않고 그 사실을 알린다', async () => {
    pageBridge.overlays.mockResolvedValue([
      overlay({ label: '결제 확인', closeIds: [], sensitive: true })
    ])
    const out = await run(get(build(), 'dismiss_overlay'))
    expect(pageBridge.click).not.toHaveBeenCalled()
    expect(out).toContain('refused')
    expect(out).toContain('결제 확인')
  })

  it('민감 레이어와 공지가 함께 있으면 공지만 닫는다', async () => {
    const notice = overlay({ label: '쿠폰', closeIds: [12] })
    const pay = overlay({ label: '결제 확인', closeIds: [], sensitive: true })
    pageBridge.overlays.mockResolvedValueOnce([notice, pay]).mockResolvedValueOnce([pay])
    const out = await run(get(build(), 'dismiss_overlay'))
    expect(pageBridge.click.mock.calls.map((c) => c[1])).toEqual([12])
    expect(out).toContain('left alone (sensitive)')
  })

  it('닫기 버튼이 없으면 누르지 않고 알린다', async () => {
    pageBridge.overlays.mockResolvedValue([overlay({ label: '전면 배너', closeIds: [] })])
    const out = await run(get(build(), 'dismiss_overlay'))
    expect(pageBridge.click).not.toHaveBeenCalled()
    expect(out).toContain('no close button')
  })

  it('결제 비밀번호 키패드 화면에서는 거부한다', async () => {
    pageBridge.keypadSignals.mockResolvedValue({
      url: 'https://pay.example/keypad',
      text: '결제 비밀번호를 입력해 주세요',
      digitButtons: 10,
      pinField: true
    })
    pageBridge.overlays.mockResolvedValue([overlay()])
    const out = await run(get(build(), 'dismiss_overlay'))
    expect(out).toBe(PAYMENT_KEYPAD_REFUSAL)
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('읽기 전용 모드에서는 거부한다', async () => {
    pageBridge.overlays.mockResolvedValue([overlay()])
    const out = await run(get(build('read_only'), 'dismiss_overlay'))
    expect(out).toContain('read-only')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })
})
