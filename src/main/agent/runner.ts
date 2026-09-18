import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import { buildSystemPrompt } from './prompt'
import { runQuery, classifyAuthError, isFatalApiError } from './provider'
import { makeCounter } from './counter'

// 확인 요청 응답 대기 상한 30분
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000

// 대기 중인 확인 요청(응답 콜백 + 만료 타이머)
interface PendingConfirm {
  resolve: (ok: boolean) => void
  timer: NodeJS.Timeout
}

// 작업 1건 실행: SDK 스트림을 읽어 UI 이벤트로 변환
export class AgentRunner {
  private abort: AbortController | null = null
  private pending = new Map<string, PendingConfirm>()

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void
  ) {}

  resolveConfirm(id: string, approved: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(approved)
  }

  // 남은 확인 요청을 모두 거부로 정리(타이머 해제 포함)
  private clearPending(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.resolve(false)
    }
    this.pending.clear()
  }

  stop(): void {
    // 실행 중이 아니면 아무것도 하지 않는다(중복 stopped 방지)
    if (!this.abort) return
    this.abort.abort()
    this.clearPending()
    this.emit({ type: 'status', state: 'stopped' })
  }

  async run(prompt: string): Promise<void> {
    if (this.abort) throw new Error('이미 실행 중')
    // 이전 작업의 잔여 확인 요청 정리
    this.clearPending()
    const s = this.settings.get()
    const abort = new AbortController()
    this.abort = abort
    const counter = makeCounter(s.maxToolCalls)
    // api_retry 로 관측한 마지막 API 오류(결과 메시지에 문구가 없을 때 사용)
    let apiError = ''
    // 종료 상태를 이미 보냈는지. SDK 는 오류 result 를 내보낸 뒤 throw 까지 하므로 중복 방지
    let settled = false
    const server = createSambaTools({
      tabs: this.tabs,
      dangerWords: s.dangerWords,
      tick: counter.tick,
      onStep: (label, ok) => this.emit({ type: 'step', label, ok }),
      confirm: (action) =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID()
          const timer = setTimeout(() => {
            // 응답이 없으면 거부 처리
            if (this.pending.delete(id)) resolve(false)
          }, CONFIRM_TIMEOUT_MS)
          // 대기 타이머가 앱 종료를 막지 않도록 한다
          timer.unref?.()
          this.pending.set(id, { resolve, timer })
          this.emit({ type: 'confirm', requestId: id, action })
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
        } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          // 인증 실패는 SDK 가 최대 10회 재시도한다(수 분 소요). 회복 불가 오류면 즉시 중단
          apiError = `${msg.error} ${msg.error_status ?? ''}`.trim()
          if (isFatalApiError(msg.error)) {
            const kind = classifyAuthError(apiError)
            settled = true
            this.emit({
              type: 'status',
              state: 'failed',
              message: kind ? `auth:${kind}` : apiError,
              toolCalls: counter.count()
            })
            abort.abort()
            return
          }
        } else if (msg.type === 'result') {
          const failed = msg.subtype !== 'success' || msg.is_error
          // 실패 사유 문구를 모아 인증 오류 여부를 판정
          const detail = [
            msg.subtype === 'success' ? (msg.is_error ? msg.result : '') : msg.errors.join(' '),
            apiError
          ]
            .filter(Boolean)
            .join(' ')
          const kind = classifyAuthError(detail)
          settled = true
          this.emit({
            type: 'status',
            state: failed ? 'failed' : 'done',
            toolCalls: counter.count(),
            message: failed ? (kind ? `auth:${kind}` : detail || msg.subtype) : undefined
          })
        }
      }
    } catch (e) {
      // stop() 또는 result 처리에서 이미 종료 상태를 보냈으면 중복 emit 하지 않는다
      if (!abort.signal.aborted && !settled) {
        const message = e instanceof Error ? e.message : String(e)
        const kind = classifyAuthError(`${message} ${apiError}`)
        this.emit({
          type: 'status',
          state: 'failed',
          message: kind ? `auth:${kind}` : message,
          toolCalls: counter.count()
        })
      }
    } finally {
      this.abort = null
      this.clearPending()
    }
  }
}
