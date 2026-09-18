import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import { buildSystemPrompt } from './prompt'
import { runQuery, classifyAuthError } from './provider'
import { makeCounter } from './counter'

// 확인 요청 응답 대기 상한 30분
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000

// 작업 1건 실행: SDK 스트림을 읽어 UI 이벤트로 변환
export class AgentRunner {
  private abort: AbortController | null = null
  private pending = new Map<string, (ok: boolean) => void>()

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void
  ) {}

  resolveConfirm(id: string, approved: boolean): void {
    this.pending.get(id)?.(approved)
    this.pending.delete(id)
  }

  stop(): void {
    this.abort?.abort()
    this.emit({ type: 'status', state: 'stopped' })
  }

  async run(prompt: string): Promise<void> {
    if (this.abort) throw new Error('이미 실행 중')
    const s = this.settings.get()
    const abort = new AbortController()
    this.abort = abort
    const counter = makeCounter(s.maxToolCalls)
    const server = createSambaTools({
      tabs: this.tabs,
      dangerWords: s.dangerWords,
      tick: counter.tick,
      onStep: (label, ok) => this.emit({ type: 'step', label, ok }),
      confirm: (action) =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID()
          this.pending.set(id, resolve)
          this.emit({ type: 'confirm', requestId: id, action })
          setTimeout(() => {
            // 응답이 없으면 거부 처리
            if (this.pending.has(id)) {
              this.pending.delete(id)
              resolve(false)
            }
          }, CONFIRM_TIMEOUT_MS)
        })
    })
    this.emit({ type: 'status', state: 'running', toolCalls: 0 })
    try {
      const stream = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(s.language),
        model: s.model,
        mcpServers: { samba: server },
        allowedTools: SAMBA_TOOL_NAMES,
        abort
      })
      for await (const msg of stream) {
        if (msg.type === 'assistant') {
          // SDKAssistantMessage.message = Anthropic API 메시지
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim())
              this.emit({ type: 'text', text: block.text })
          }
        } else if (msg.type === 'result') {
          const failed = msg.subtype !== 'success'
          this.emit({
            type: 'status',
            state: failed ? 'failed' : 'done',
            toolCalls: counter.count(),
            message: failed ? msg.subtype : undefined
          })
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const kind = classifyAuthError(message)
      this.emit({
        type: 'status',
        state: abort.signal.aborted ? 'stopped' : 'failed',
        message: kind ? `auth:${kind}` : message,
        toolCalls: counter.count()
      })
    } finally {
      this.abort = null
    }
  }
}
