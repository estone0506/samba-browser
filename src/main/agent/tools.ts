import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import { isDangerous } from '../../shared/danger'
import type { PermissionMode } from '../../shared/settings'

// 읽기 전용 모드에서 실행 자체를 거부할 때 돌려주는 문자열(AI 가 읽고 판단)
const READ_ONLY_REFUSAL = 'refused: read-only mode'
// finalConfirm 이 거부됐을 때 모델이 계속 작업하도록 돌려주는 문자열
const CONTINUE_INSTRUCTION = 'user asked to continue; do not finish yet'

export interface ToolContext {
  tabs: TabManager
  dangerWords: string[]
  // 사용 권한 모드. read_only 는 조작 도구를 실행하지 않고, full 은 위험 단어 확인을 생략한다
  mode: PermissionMode
  // 켜져 있으면 done 호출 전에 확인 카드를 띄운다
  finalConfirm: boolean
  // 위험 행동 확인. 승인이면 true. kind 로 위험/완료 확인 카드를 구분한다
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
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
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 위험 판정 근거는 페이지의 실제 텍스트. AI 가 준 label 은 기록용일 뿐 신뢰하지 않는다
        const pageText = await pageBridge.textOf(tab, id)
        // full 모드는 위험 단어 확인을 생략한다(SECRET 거부·URL 허용목록·호출 상한은 그대로 유지)
        if (ctx.mode !== 'full' && isDangerous(`${pageText} ${label}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`클릭: ${pageText || label}`, 'danger')
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
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 입력값 자체와 대상 입력칸의 실제 텍스트를 함께 판정
        const pageText = await pageBridge.textOf(tab, id)
        if (ctx.mode !== 'full' && isDangerous(`${pageText} ${t}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`입력: ${t}${pageText ? ` → ${pageText}` : ''}`, 'danger')
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
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
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
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
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

  // done 은 guard 를 거치지 않으므로 도구 호출 상한(tick)에 계산되지 않는다.
  // 상한에 도달했을 때 "done 으로 마무리하라"고 안내하기 때문에, 마무리 호출까지 막으면 안 된다
  const done = tool(
    'done',
    'Finish the task with a short summary for the user.',
    { summary: z.string() },
    async ({ summary }) => {
      if (ctx.finalConfirm) {
        const ok = await ctx.confirm(summary, 'finish')
        if (!ok) {
          ctx.onStep(`계속 진행: ${summary.slice(0, 60)}`, true)
          return text(CONTINUE_INSTRUCTION)
        }
      }
      ctx.onStep(`완료: ${summary.slice(0, 60)}`, true)
      return text(`DONE: ${summary}`)
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
