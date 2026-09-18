import { describe, it, expect, vi } from 'vitest'
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

vi.mock('../src/main/browser/page-bridge', () => ({
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

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

type ImageBlock = { type: 'image'; data: string; mimeType: string }
type TextBlock = { type: 'text'; text: string }
interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: (ImageBlock | TextBlock)[] }>
}

// NativeImage 흉내: resize 는 자기 자신을 돌려주고(테스트에서 크기 계산은 중요하지 않음),
// toJPEG 는 임의의 버퍼를 돌려준다
function fakeNativeImage(
  w: number,
  h: number
): {
  getSize: () => { width: number; height: number }
  resize: (opts: { width?: number; height?: number }) => ReturnType<typeof fakeNativeImage>
  toJPEG: (quality: number) => Buffer
} {
  return {
    getSize: () => ({ width: w, height: h }),
    resize: (opts) => fakeNativeImage(opts.width ?? w, opts.height ?? h),
    toJPEG: () => Buffer.from('fake-jpeg-bytes')
  }
}

function build(opts: {
  mode?: ToolContext['mode']
  hasTab?: boolean
  bounds?: { width: number; height: number }
  capturePage?: () => Promise<ReturnType<typeof fakeNativeImage>>
}): { tools: ToolStub[]; steps: Array<{ label: string; ok: boolean }> } {
  const bounds = opts.bounds ?? { width: 800, height: 600 }
  const capturePage = opts.capturePage ?? (async () => fakeNativeImage(2560, 1440))
  const fakeTab = {
    id: 't1',
    view: {
      getBounds: () => ({ x: 0, y: 0, ...bounds }),
      webContents: {
        getURL: () => 'https://shop.example/cart',
        capturePage
      }
    },
    profile: 'default',
    mobile: false
  }
  const steps: Array<{ label: string; ok: boolean }> = []
  const tabs = {
    active: () => (opts.hasTab === false ? null : fakeTab),
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: opts.mode ?? 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok })
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, steps }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!

describe('screenshot 도구', () => {
  it('활성 탭을 캡처해 image 블록과 text 블록을 함께 돌려준다', async () => {
    const { tools, steps } = build({})
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toHaveLength(2)
    const image = r.content.find((c): c is ImageBlock => c.type === 'image')
    const textBlock = r.content.find((c): c is TextBlock => c.type === 'text')
    expect(image).toBeDefined()
    expect(image!.mimeType).toBe('image/jpeg')
    expect(image!.data.length).toBeGreaterThan(0)
    expect(textBlock).toBeDefined()
    expect(textBlock!.text).toContain('shop.example')
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: true })
  })

  it('read_only 모드에서도 허용된다', async () => {
    const { tools } = build({ mode: 'read_only' })
    const r = await get(tools, 'screenshot').handler({})
    const image = r.content.find((c): c is ImageBlock => c.type === 'image')
    expect(image).toBeDefined()
    expect(image!.data.length).toBeGreaterThan(0)
  })

  it('활성 탭이 없으면 no visible page 를 돌려준다', async () => {
    const { tools, steps } = build({ hasTab: false })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([{ type: 'text', text: 'no visible page' }])
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: false })
  })

  it('웹뷰가 접혀(bounds 0) 있으면 no visible page 를 돌려준다(키마스터 페이지)', async () => {
    const { tools } = build({ bounds: { width: 0, height: 0 } })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([{ type: 'text', text: 'no visible page' }])
  })
})
