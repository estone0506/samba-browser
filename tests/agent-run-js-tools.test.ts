import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const emptySnapshot = {
  url: 'https://shop.example/cart',
  title: '장바구니',
  text: '주문 합계 1000원',
  elements: [{ id: 3, tag: 'button', role: 'button', text: '주문하기', isSecret: false }],
  total: 1
}

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    keypadSignals: vi.fn(async () => ({
      url: 'https://shop.example/',
      text: '',
      digitButtons: 0,
      pinField: false
    })),
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    isSecretField: vi.fn(async () => false),
    overlays: vi.fn(async () => []),
    captchaHint: vi.fn(async () => ({ needsUser: false, matched: '' })),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES } = await import('../src/main/agent/tools')
const { secretKeypadGate } = await import('../src/main/agent/secret-page')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://shop.example/cart', getTitle: () => '장바구니' } },
  profile: 'default',
  mobile: false
}

function build(
  opts: {
    mode?: ToolContext['mode']
    confirmResult?: boolean
    limit?: number
  } = {}
): {
  run: (code: string) => Promise<string>
  confirm: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  ticks: () => number
} {
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const steps: Array<{ label: string; ok: boolean }> = []
  let ticked = 0
  const tabs = {
    active: () => fakeTab,
    create: vi.fn(() => ({ id: 't2' })),
    activate: vi.fn(),
    close: vi.fn(),
    list: () => [{ id: 't1', title: '장바구니', url: 'https://shop.example/cart', active: true }],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: opts.mode ?? 'guard',
    finalConfirm: false,
    confirm,
    tick: () => {
      ticked += 1
      return opts.limit !== undefined && ticked > opts.limit ? 'tool call limit reached' : null
    },
    onStep: (label, ok) => steps.push({ label, ok })
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  const runJs = server.tools.find((t) => t.name === 'run_js')!
  return {
    run: async (code) => (await runJs.handler({ code })).content[0].text,
    confirm,
    steps,
    ticks: () => ticked
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 키패드 판정은 탭별로 500ms 캐시된다 — 테스트끼리 섞이지 않게 비운다
  secretKeypadGate.clear()
  pageBridge.snapshot.mockResolvedValue(emptySnapshot)
  pageBridge.textOf.mockResolvedValue('')
  pageBridge.isSecretField.mockResolvedValue(false)
  pageBridge.keypadSignals.mockResolvedValue({
    url: 'https://shop.example/',
    text: '',
    digitButtons: 0,
    pinField: false
  })
})

describe('run_js 도구 등록', () => {
  it('허용 도구 목록에 들어 있다', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__run_js')
  })

  it('진행 라벨은 "코드 실행: …" 이다', async () => {
    const { run, steps } = build()
    await run("await page.click(3, '주문하기')")
    expect(steps[0].label).toBe("코드 실행: await page.click(3, '주문하기')")
  })
})

describe('run_js 는 도구와 같은 가드를 지난다', () => {
  it('read_only 에서 클릭을 거부한다', async () => {
    const { run } = build({ mode: 'read_only' })
    expect(await run("return await page.click(3, '주문하기')")).toContain('refused: read-only mode')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('read_only 에서도 읽기는 된다', async () => {
    const { run } = build({ mode: 'read_only' })
    expect(await run('return (await page.get()).total')).toBe('1')
  })

  it('위험 단어가 있으면 확인을 받는다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { run, confirm } = build({ confirmResult: true })
    await run("await page.click(3, '결제')")
    expect(confirm).toHaveBeenCalledWith('클릭: 결제하기', 'danger')
  })

  it('사용자가 거부하면 클릭하지 않는다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { run } = build({ confirmResult: false })
    expect(await run("return await page.click(3, '결제')")).toContain('denied by user')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('full 모드는 위험 단어 확인을 건너뛴다', async () => {
    pageBridge.textOf.mockResolvedValue('결제하기')
    const { run, confirm } = build({ mode: 'full' })
    await run("await page.click(3, '결제')")
    expect(confirm).not.toHaveBeenCalled()
    expect(pageBridge.click).toHaveBeenCalled()
  })

  it('결제 비밀번호 키패드에서는 클릭·입력을 거부한다', async () => {
    pageBridge.keypadSignals.mockResolvedValue({
      url: 'https://pay.example/keypad',
      text: '결제 비밀번호를 입력하세요',
      digitButtons: 10,
      pinField: true
    })
    const { run } = build()
    const out = await run("return await page.click(3, '1')")
    expect(out).toContain('refused: payment keypad')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })

  it('비밀 입력칸에는 run_js 로 값을 넣을 수 없다', async () => {
    pageBridge.isSecretField.mockResolvedValue(true)
    const { run } = build()
    const out = await run("return await page.type(3, 'hunter2')")
    expect(out).toContain('secret field')
    expect(pageBridge.type).not.toHaveBeenCalled()
  })

  it('비밀 경로 도구는 샌드박스에 없다', async () => {
    const { run } = build()
    const out = await run("return typeof fill_secret + ',' + typeof login + ',' + typeof phone_tap")
    expect(out).toBe('undefined,undefined,undefined')
  })
})

describe('run_js 호출 상한', () => {
  it('run_js 1회 + 동작 5건당 1회로 센다(동작마다 세면 상한이 금방 바닥난다)', async () => {
    const { run, ticks } = build()
    await run("await page.click(1, 'a'); await page.click(2, 'b'); await sleep(1)")
    // run_js 자체 1회. 동작 2건은 5건 미만이라 추가로 세지 않는다
    expect(ticks()).toBe(1)
    await run(
      "await page.click(1, 'a'); await page.click(2, 'b'); await page.click(3, 'c'); await page.click(4, 'd'); await page.click(5, 'e')"
    )
    // 두 번째 run_js 1회 + 누적 동작 7건 → 5건째에서 1회
    expect(ticks()).toBe(3)
  })

  it('상한을 넘으면 그 자리에서 멈춘다', async () => {
    const { run } = build({ limit: 1 })
    const out = await run(
      "await page.click(1, 'a'); await page.click(2, 'b'); await page.click(3, 'c'); await page.click(4, 'd'); await page.click(5, 'e'); await page.click(6, 'f')"
    )
    expect(out).toContain('tool call limit reached')
    // run_js 1회로 상한(1)에 닿고, 5번째 동작에서 상한 검사에 걸려 6번째는 실행되지 않는다
    expect(pageBridge.click).toHaveBeenCalledTimes(4)
  })

  it('tree·diff·total·elements 를 돌려준다', async () => {
    const { run } = build()
    const out = await run('const s = await page.get(); return Object.keys(s).sort().join(",")')
    expect(out).toBe('diff,elements,total,tree')
  })

  it('처음 get 의 diff 는 트리 전체다', async () => {
    const { run } = build()
    const out = await run('const s = await page.get(); return s.diff === s.tree')
    expect(out).toBe('true')
  })

  it('같은 실행 안에서 두 번째 get 은 바뀐 줄만 돌려준다', async () => {
    const { run } = build()
    pageBridge.snapshot
      .mockResolvedValueOnce(emptySnapshot)
      .mockResolvedValueOnce({ ...emptySnapshot, text: '주문 합계 2000원' })
    const out = await run('await page.get(); const s = await page.get(); return s.diff')
    expect(out).toContain('+주문 합계 2000원')
    expect(out).toContain('-주문 합계 1000원')
    expect(out).toContain('@@')
  })

  it('selector 를 그대로 넘긴다', async () => {
    const { run } = build()
    await run("await page.get({ selector: '.OptionArea' })")
    expect(pageBridge.snapshot).toHaveBeenCalledWith(fakeTab, undefined, '.OptionArea')
  })

  it('잘못된 selector 는 오류 문자열이다', async () => {
    pageBridge.snapshot.mockResolvedValue({
      ...emptySnapshot,
      elements: [],
      selectorError: 'invalid selector: [[['
    })
    const { run } = build()
    expect(await run("return await page.get({ selector: '[[[' })")).toContain('invalid selector')
  })
})

describe('get_page 의 diff 인자', () => {
  const getPageOf = (): ToolStub => {
    const ctx: ToolContext = {
      tabs: {
        active: () => fakeTab,
        create: vi.fn(),
        activate: vi.fn(),
        list: () => [],
        navigate: vi.fn(async () => {})
      } as unknown as TabManager,
      dangerWords: DEFAULT_DANGER_WORDS,
      mode: 'guard',
      finalConfirm: false,
      confirm: vi.fn(async () => true),
      tick: () => null,
      onStep: () => {}
    }
    const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
    return server.tools.find((t) => t.name === 'get_page')!
  }

  it('첫 호출은 diff 를 부탁해도 트리 전체를 준다', async () => {
    const getPage = getPageOf()
    const out = (await getPage.handler({ diff: true })).content[0].text
    expect(out).toContain('INTERACTIVE ELEMENTS:')
  })

  it('두 번째 호출은 바뀐 줄만 준다', async () => {
    const getPage = getPageOf()
    await getPage.handler({ diff: true })
    pageBridge.snapshot.mockResolvedValue({ ...emptySnapshot, text: '주문 합계 3000원' })
    const out = (await getPage.handler({ diff: true })).content[0].text
    expect(out).toContain('+주문 합계 3000원')
    expect(out).not.toContain('INTERACTIVE ELEMENTS:')
  })

  it('바뀐 게 없으면 그렇다고 알린다', async () => {
    const getPage = getPageOf()
    await getPage.handler({ diff: true })
    const out = (await getPage.handler({ diff: true })).content[0].text
    expect(out).toContain('no change since the last get_page')
  })

  it('잘못된 selector 는 오류 문자열이다', async () => {
    pageBridge.snapshot.mockResolvedValue({
      ...emptySnapshot,
      elements: [],
      selectorError: 'invalid selector: [[['
    })
    const getPage = getPageOf()
    const out = (await getPage.handler({ selector: '[[[' })).content[0].text
    expect(out).toContain('invalid selector')
  })
})
