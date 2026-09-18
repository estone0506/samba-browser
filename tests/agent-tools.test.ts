import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

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

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')
const { isAllowedUrl, BLOCKED_URL_MESSAGE } = await import('../src/shared/url')
const { setOcrEnabled } = await import('../src/main/agent/tools-ocr')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://shop.example/cart' } },
  profile: 'default',
  mobile: false
}

// tabs.create 는 실제 TabManager 와 같은 관문(URL 허용 목록)을 거치도록 흉내낸다
const create = vi.fn((o: { url?: string } = {}) => {
  const url = o.url ?? 'https://www.google.com'
  if (!isAllowedUrl(url)) throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
  return { id: 't2' }
})

function build(
  confirmResult: boolean,
  opts: { mode?: ToolContext['mode']; finalConfirm?: boolean } = {}
): {
  tools: ToolStub[]
  confirm: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
} {
  const confirm = vi.fn(async () => confirmResult)
  const steps: Array<{ label: string; ok: boolean }> = []
  const tabs = {
    active: () => fakeTab,
    create,
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: opts.mode ?? 'guard',
    finalConfirm: opts.finalConfirm ?? false,
    confirm,
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok })
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, confirm, steps }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const textOut = (r: { content: { text: string }[] }): string => r.content[0].text

beforeEach(() => {
  pageBridge.textOf.mockReset()
  pageBridge.click.mockReset()
  pageBridge.click.mockImplementation(async () => 'ok')
  pageBridge.type.mockReset()
  pageBridge.type.mockImplementation(async () => 'ok')
  pageBridge.waitForLoad.mockClear()
  create.mockClear()
})

describe('click 위험 게이트 — 판정 근거는 AI 라벨이 아니라 페이지 텍스트', () => {
  it("페이지 텍스트가 '결제하기' 면 AI 라벨이 '계속' 이어도 확인을 요청한다", async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { tools, confirm } = build(true)
    const r = await get(tools, 'click').handler({ id: 3, label: '계속' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('결제하기')
    expect(pageBridge.click).toHaveBeenCalledWith(fakeTab, 3)
    expect(textOut(r)).toBe('ok')
  })

  it('거부하면 denied by user 를 돌려주고 클릭하지 않는다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { tools, confirm, steps } = build(false)
    const r = await get(tools, 'click').handler({ id: 3, label: '계속' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(textOut(r)).toBe('denied by user')
    expect(pageBridge.click).not.toHaveBeenCalled()
    expect(steps.at(-1)?.ok).toBe(false)
  })

  it('영문 페이지의 Place order 도 확인을 요청한다', async () => {
    pageBridge.textOf.mockResolvedValue('Place order')
    const { tools, confirm } = build(false)
    await get(tools, 'click').handler({ id: 1, label: 'Next' })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('위험하지 않은 요소는 확인 없이 바로 클릭한다', async () => {
    pageBridge.textOf.mockResolvedValue('장바구니 보기')
    const { tools, confirm } = build(true)
    await get(tools, 'click').handler({ id: 2, label: '계속' })
    expect(confirm).not.toHaveBeenCalled()
    expect(pageBridge.click).toHaveBeenCalledWith(fakeTab, 2)
  })
})

describe('type 위험 게이트', () => {
  it('입력칸의 페이지 텍스트가 위험하면 확인을 요청한다', async () => {
    pageBridge.textOf.mockResolvedValue('결제 금액')
    const { tools, confirm } = build(true)
    await get(tools, 'type').handler({ id: 5, text: '10000', submit: false })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(pageBridge.type).toHaveBeenCalledWith(fakeTab, 5, '10000', false)
  })

  it('거부하면 입력하지 않는다', async () => {
    pageBridge.textOf.mockResolvedValue('결제 금액')
    const { tools } = build(false)
    const r = await get(tools, 'type').handler({ id: 5, text: '10000', submit: false })
    expect(textOut(r)).toBe('denied by user')
    expect(pageBridge.type).not.toHaveBeenCalled()
  })
})

describe('new_tab URL 관문', () => {
  it('file:// 은 거부한다', async () => {
    const { tools } = build(true)
    const r = await get(tools, 'new_tab').handler({ url: 'file:///C:/Windows/win.ini' })
    expect(textOut(r)).toMatch(/refused/)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('javascript: 도 거부한다', async () => {
    const { tools } = build(true)
    const r = await get(tools, 'new_tab').handler({ url: 'javascript:alert(1)' })
    expect(textOut(r)).toMatch(/refused/)
  })

  it('https 는 연다', async () => {
    const { tools } = build(true)
    const r = await get(tools, 'new_tab').handler({ url: 'https://www.google.com' })
    expect(textOut(r)).toBe('ok: tab t2')
  })

  it('내부 페이지(samba://newtab)는 거부하고 탭도 만들지 않는다', async () => {
    const { tools } = build(true)
    const r = await get(tools, 'new_tab').handler({ url: 'samba://newtab' })
    expect(textOut(r)).toMatch(/refused/)
    expect(create).not.toHaveBeenCalled()
  })

  it('url 없이 열면 빈 페이지로 연다(기본값이 내부 페이지여도 AI 는 못 본다)', async () => {
    const { tools } = build(true)
    await get(tools, 'new_tab').handler({})
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ url: 'about:blank' }))
  })
})

describe('navigate URL 관문', () => {
  it('내부 페이지(samba://newtab)는 거부하고 이동도 하지 않는다', async () => {
    const { tools } = build(true)
    const r = await get(tools, 'navigate').handler({ url: 'samba://newtab' })
    expect(textOut(r)).toMatch(/refused/)
  })
})

describe('read_only 모드 — 조작 도구는 실행하지 않고 거부한다', () => {
  it('click 은 확인 없이 refused 를 반환하고 실제 클릭은 하지 않는다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { tools, confirm } = build(true, { mode: 'read_only' })
    const r = await get(tools, 'click').handler({ id: 3, label: '계속' })
    expect(textOut(r)).toMatch(/refused/)
    expect(confirm).not.toHaveBeenCalled()
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('type 도 refused 를 반환한다', async () => {
    const { tools } = build(true, { mode: 'read_only' })
    const r = await get(tools, 'type').handler({ id: 1, text: 'hi', submit: false })
    expect(textOut(r)).toMatch(/refused/)
    expect(pageBridge.type).not.toHaveBeenCalled()
  })

  it('new_tab 도 refused 를 반환하고 tabs.create 를 호출하지 않는다', async () => {
    const { tools } = build(true, { mode: 'read_only' })
    const r = await get(tools, 'new_tab').handler({ url: 'https://www.google.com' })
    expect(textOut(r)).toMatch(/refused/)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('full 모드 — 위험 단어 확인 없이 바로 실행한다', () => {
  it('위험한 클릭도 confirm 없이 바로 실행된다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { tools, confirm } = build(true, { mode: 'full' })
    const r = await get(tools, 'click').handler({ id: 3, label: '계속' })
    expect(confirm).not.toHaveBeenCalled()
    expect(pageBridge.click).toHaveBeenCalledWith(fakeTab, 3)
    expect(textOut(r)).toBe('ok')
  })

  it('new_tab 은 URL 허용목록은 그대로 유지한다', async () => {
    const { tools } = build(true, { mode: 'full' })
    const r = await get(tools, 'new_tab').handler({ url: 'file:///C:/Windows/win.ini' })
    expect(textOut(r)).toMatch(/refused/)
  })
})

describe('finalConfirm — done 호출 전에 확인 카드를 띄운다', () => {
  it('거부하면 계속 지시 문자열을 반환하고 완료 스텝을 기록하지 않는다', async () => {
    const { tools, confirm, steps } = build(false, { finalConfirm: true })
    const r = await get(tools, 'done').handler({ summary: '작업 완료' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][1]).toBe('finish')
    expect(textOut(r)).toBe('user asked to continue; do not finish yet')
    expect(steps.some((s) => s.label.startsWith('완료:'))).toBe(false)
  })

  it('승인하면 정상 완료된다', async () => {
    const { tools, confirm } = build(true, { finalConfirm: true })
    const r = await get(tools, 'done').handler({ summary: '작업 완료' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(textOut(r)).toBe('DONE: 작업 완료')
  })

  it('꺼져 있으면 confirm 을 호출하지 않는다', async () => {
    const { tools, confirm } = build(true, { finalConfirm: false })
    const r = await get(tools, 'done').handler({ summary: '작업 완료' })
    expect(confirm).not.toHaveBeenCalled()
    expect(textOut(r)).toBe('DONE: 작업 완료')
  })
})

describe('ocr — 설정(ocrEnabled) 반영', () => {
  afterEach(() => {
    // 다른 테스트에 영향을 주지 않도록 기본값(켬)으로 되돌린다
    setOcrEnabled(true)
  })

  it('ocrEnabled 를 false 로 설정하면 캡처하지 않고 바로 거부한다', async () => {
    setOcrEnabled(false)
    const { tools, steps } = build(true)
    const r = await get(tools, 'ocr').handler({})
    expect(textOut(r)).toBe('refused: OCR is disabled in settings')
    expect(steps.at(-1)?.ok).toBe(false)
  })
})
