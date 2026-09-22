// 브릿지가 쓰는 도구 세션 — 채팅 실행과 겹치지 않고, 도구를 이름으로 부른다
import { describe, it, expect, vi } from 'vitest'
import { AgentRunner } from '../src/main/agent/runner'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 .tools 배열을 직접 볼 수 있게 한다
// (다른 도구 테스트들과 같은 관례 — 실제 SDK 는 McpServer 인스턴스만 돌려준다)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    snapshot: vi.fn(async () => ({
      url: 'https://a.test/',
      title: 'A',
      text: '본문',
      elements: []
    })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    rectOf: vi.fn(async () => null),
    overlays: vi.fn(async () => [])
  }
}))

function runner(): AgentRunner {
  const tabs = {
    active: () => ({
      id: 't1',
      view: { webContents: { getURL: () => 'https://a.test/', isDestroyed: () => false } }
    }),
    list: () => [],
    listTargets: () => [],
    create: vi.fn(),
    activate: vi.fn(),
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const settings = { get: () => ({ ...DEFAULT_SETTINGS }) } as unknown as SettingsStore
  return new AgentRunner(tabs, settings, () => {})
}

describe('createToolSession', () => {
  it('도구 이름 목록을 주고, 없는 이름은 거부한다', async () => {
    const s = runner().createToolSession({})
    expect(s.names()).toContain('get_page')
    expect(s.names()).toContain('run_js')
    expect(s.names()).not.toContain('done')
    await expect(s.call('없는_도구', {})).rejects.toThrow('unknown tool')
    s.dispose()
  })

  it('세션이 살아 있는 동안 채팅 실행은 거부되고, 닫으면 풀린다', async () => {
    const r = runner()
    const s = r.createToolSession({})
    await expect(r.run('아무 지시')).rejects.toThrow('브릿지 세션 사용 중')
    s.dispose()
    // dispose 뒤에는 세션 검사에 걸리지 않는다 — 새 세션을 실제로 만들어 도구 목록이 나오는지 본다
    const again = r.createToolSession({})
    expect(again.names()).toContain('get_page')
    again.dispose()
  })

  it('세션이 이미 열려 있으면 두 번째 createToolSession 은 거부된다', () => {
    const r = runner()
    const s = r.createToolSession({})
    expect(() => r.createToolSession({})).toThrow('브릿지 세션 사용 중')
    s.dispose()
  })

  it('읽기 전용 모드에서는 세션을 열 수 없다', () => {
    const tabs = {
      active: () => ({
        id: 't1',
        view: { webContents: { getURL: () => 'https://a.test/', isDestroyed: () => false } }
      }),
      list: () => [],
      listTargets: () => [],
      create: vi.fn(),
      activate: vi.fn(),
      navigate: vi.fn(async () => {})
    } as unknown as TabManager
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS, permissionMode: 'read_only' as const })
    } as unknown as SettingsStore
    const r = new AgentRunner(tabs, settings, () => {})
    expect(() => r.createToolSession({})).toThrow('읽기 전용 모드에서는 브릿지를 쓸 수 없음')
  })

  it('도구 호출은 진행 로그를 onStep 으로 넘긴다', async () => {
    const steps: string[] = []
    const s = runner().createToolSession({ onStep: (label) => steps.push(label) })
    const out = await s.call('get_page', {})
    expect(typeof out).toBe('string')
    expect(steps.some((l) => l.includes('페이지 읽기'))).toBe(true)
    s.dispose()
  })
})
