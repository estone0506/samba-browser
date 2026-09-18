import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import { isDangerous } from '../../shared/danger'

export interface ToolContext {
  tabs: TabManager
  dangerWords: string[]
  // 위험 행동 확인. 승인이면 true
  confirm: (action: string) => Promise<boolean>
  // 호출 카운터. 상한 넘으면 문자열 반환
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text' as const, text: t }]
})

// 현재 탭이 없으면 null
function activeOr(ctx: ToolContext): ReturnType<TabManager['active']> {
  return ctx.tabs.active()
}

export function createSambaTools(ctx: ToolContext): ReturnType<typeof createSdkMcpServer> {
  // 상한 도달 알림은 1회만 보낸다
  let limitNotified = false

  const guard = async <T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<ReturnType<typeof text>> => {
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      return text(over)
    }
    try {
      const r = await fn()
      const s = typeof r === 'string' ? r : JSON.stringify(r)
      ctx.onStep(label, !/not found|refused|denied|error/i.test(s))
      return text(s)
    } catch (e) {
      ctx.onStep(label, false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const getPage = tool(
    'get_page',
    'Read the current page: URL, title, numbered interactive elements, visible text.',
    {},
    () =>
      guard('페이지 읽기', async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        await pageBridge.waitForLoad(tab)
        return serializeSnapshot(await pageBridge.snapshot(tab))
      })
  )

  const navigate = tool(
    'navigate',
    'Open a URL or search query in the active tab.',
    { url: z.string() },
    ({ url }) =>
      guard(`이동: ${url}`, async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        await ctx.tabs.navigate(tab.id, url)
        await pageBridge.waitForLoad(tab)
        return `ok: ${tab.view.webContents.getURL()}`
      })
  )

  const click = tool(
    'click',
    'Click element [n] from get_page.',
    { id: z.number().int(), label: z.string().describe('element text, for logging') },
    ({ id, label }) =>
      guard(`클릭: ${label} (#${id})`, async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 위험 판정 근거는 페이지의 실제 텍스트. AI 가 준 label 은 기록용일 뿐 신뢰하지 않는다
        const pageText = await pageBridge.textOf(tab, id)
        if (isDangerous(`${pageText} ${label}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`클릭: ${pageText || label}`)
          if (!ok) return 'denied by user'
        }
        const r = await pageBridge.click(tab, id)
        await pageBridge.waitForLoad(tab)
        return r
      })
  )

  const typeTool = tool(
    'type',
    'Type text into input [n]. submit=true presses Enter.',
    { id: z.number().int(), text: z.string(), submit: z.boolean().default(false) },
    ({ id, text: t, submit }) =>
      guard(`입력: "${t.slice(0, 30)}" (#${id})`, async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 입력값 자체와 대상 입력칸의 실제 텍스트를 함께 판정
        const pageText = await pageBridge.textOf(tab, id)
        if (isDangerous(`${pageText} ${t}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`입력: ${t}${pageText ? ` → ${pageText}` : ''}`)
          if (!ok) return 'denied by user'
        }
        const r = await pageBridge.type(tab, id, t, submit)
        if (submit) await pageBridge.waitForLoad(tab)
        return r
      })
  )

  const select = tool(
    'select',
    'Choose an option in <select> [n] by value or visible text.',
    { id: z.number().int(), value: z.string() },
    ({ id, value }) =>
      guard(`선택: ${value} (#${id})`, async () => {
        const tab = activeOr(ctx)
        return tab ? pageBridge.select(tab, id, value) : 'no active tab'
      })
  )

  const scroll = tool(
    'scroll',
    'Scroll the page up or down.',
    { direction: z.enum(['up', 'down']) },
    ({ direction }) =>
      guard(`스크롤 ${direction}`, async () => {
        const tab = activeOr(ctx)
        return tab ? pageBridge.scroll(tab, direction) : 'no active tab'
      })
  )

  const wait = tool(
    'wait',
    'Wait up to 5000 ms for the page to settle.',
    { ms: z.number().int().min(100).max(5000) },
    ({ ms }) =>
      guard(`대기 ${ms}ms`, async () => {
        await new Promise((r) => setTimeout(r, ms))
        return 'ok'
      })
  )

  const newTab = tool(
    'new_tab',
    'Open a new tab (optionally with profile name and mobile mode) and make it active.',
    { url: z.string().optional(), profile: z.string().optional(), mobile: z.boolean().optional() },
    (o) =>
      guard(`새 탭 ${o.profile ?? ''}`, async () => {
        const t = ctx.tabs.create(o)
        return `ok: tab ${t.id}`
      })
  )

  const switchTab = tool(
    'switch_tab',
    'Activate a tab by id (see list in results).',
    { id: z.string() },
    ({ id }) =>
      guard('탭 전환', async () => {
        ctx.tabs.activate(id)
        return `ok. tabs: ${JSON.stringify(
          ctx.tabs.list().map((t) => ({ id: t.id, title: t.title, profile: t.profile }))
        )}`
      })
  )

  const done = tool(
    'done',
    'Finish the task with a short summary for the user.',
    { summary: z.string() },
    ({ summary }) => {
      ctx.onStep(`완료: ${summary.slice(0, 60)}`, true)
      return Promise.resolve(text(`DONE: ${summary}`))
    }
  )

  return createSdkMcpServer({
    name: 'samba',
    version: '0.1.0',
    tools: [getPage, navigate, click, typeTool, select, scroll, wait, newTab, switchTab, done]
  })
}

export const SAMBA_TOOL_NAMES = [
  'get_page',
  'navigate',
  'click',
  'type',
  'select',
  'scroll',
  'wait',
  'new_tab',
  'switch_tab',
  'done'
].map((n) => `mcp__samba__${n}`)
