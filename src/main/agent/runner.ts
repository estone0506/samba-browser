import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
import type { VaultService } from '../vault/service'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import { buildSystemPrompt } from './prompt'
import { runQuery, classifyAuthError, isFatalApiError } from './provider'
import { makeCounter } from './counter'
import { createTextDeduper } from './dedupe'

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
  // 실행 세대 번호. 중단된 이전 스트림이 뒤늦게 보내는 이벤트를 걸러낸다
  private generation = 0

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void,
    // 개인정보 금고. 없으면 금고 도구는 잠금으로 동작한다
    private vault?: VaultService
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
    const abort = this.abort
    // 곧바로 새 작업을 받을 수 있도록 abort 를 동기적으로 비운다.
    // (SDK 스트림은 재시도 백오프 중이면 수십 초 뒤에야 끝나므로 finally 를 기다릴 수 없다)
    this.abort = null
    // 세대를 올려 이전 스트림의 잔여 이벤트를 무시한다
    this.generation += 1
    abort.abort()
    this.clearPending()
    this.emit({ type: 'status', state: 'stopped' })
  }

  async run(prompt: string): Promise<void> {
    // 이미 실행 중이면 세대 가드 없이 status 를 emit 하면 진행 중인 실행의 UI 를 덮어쓸 수 있다.
    // 핸들러가 throw 를 { ok: false, error } 로 ack 하므로 에러만 던진다.
    if (this.abort) {
      throw new Error('이미 실행 중')
    }
    // 이전 작업의 잔여 확인 요청 정리
    this.clearPending()
    const s = this.settings.get()
    const abort = new AbortController()
    this.abort = abort
    const gen = ++this.generation
    // 이 실행이 최신 세대일 때만 UI 로 이벤트를 보낸다
    const emit = (e: AgentEvent): void => {
      if (gen === this.generation) this.emit(e)
    }
    const counter = makeCounter(s.maxToolCalls)
    const deduper = createTextDeduper()
    // api_retry 로 관측한 마지막 API 오류(결과 메시지에 문구가 없을 때 사용)
    let apiError = ''
    // 종료 상태를 이미 보냈는지. SDK 는 오류 result 를 내보낸 뒤 throw 까지 하므로 중복 방지
    let settled = false
    // 이번 실행의 감사 로그 식별자(금고 fill 기록에 남는다)
    const jobId = randomUUID()
    const server = createSambaTools({
      tabs: this.tabs,
      vault: this.vault,
      jobId,
      dangerWords: s.dangerWords,
      mode: s.permissionMode,
      finalConfirm: s.finalConfirm,
      vaultAccessPolicy: s.vaultAccessPolicy,
      vaultAutoSubmit: s.vaultAutoSubmit,
      vaultExcludedHosts: s.vaultExcludedHosts,
      tick: counter.tick,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      confirm: (action, kind = 'danger') =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID()
          const timer = setTimeout(() => {
            // 응답이 없으면 거부 처리
            if (this.pending.delete(id)) resolve(false)
          }, CONFIRM_TIMEOUT_MS)
          // 대기 타이머가 앱 종료를 막지 않도록 한다
          timer.unref?.()
          this.pending.set(id, { resolve, timer })
          emit({ type: 'confirm', requestId: id, action, kind })
        })
    })
    emit({ type: 'status', state: 'running', toolCalls: 0 })
    try {
      const stream = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(s.language, s.permissionMode),
        model: s.model,
        mcpServers: { samba: server },
        allowedTools: SAMBA_TOOL_NAMES,
        abort
      })
      for await (const msg of stream) {
        // 중단됐으면 남은 메시지는 읽지 않는다(스트림이 늦게 끝나도 UI 는 즉시 정리됨)
        if (abort.signal.aborted) break
        if (msg.type === 'assistant') {
          // SDKAssistantMessage.message = Anthropic API 메시지.
          // 같은 문단이 두 번 실려 오는 경우가 있어 중복 제거기를 거친다
          for (const block of msg.message.content) {
            if (block.type !== 'text') continue
            const text = deduper.accept(block.text)
            if (text) emit({ type: 'text', text })
          }
        } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          // 인증 실패는 SDK 가 최대 10회 재시도한다(수 분 소요). 회복 불가 오류면 즉시 중단
          apiError = `${msg.error} ${msg.error_status ?? ''}`.trim()
          if (isFatalApiError(msg.error)) {
            const kind = classifyAuthError(apiError)
            settled = true
            emit({
              type: 'status',
              state: 'failed',
              message: kind ? `auth:${kind}` : apiError,
              toolCalls: counter.count()
            })
            abort.abort()
            return
          }
          // 재시도 가능한 오류(rate_limit·overloaded·server_error)는 진행 띠에만 알린다
          emit({ type: 'progress', kind: 'apiRetry', attempt: msg.attempt, reason: msg.error })
        } else if (msg.type === 'result') {
          const failed = msg.subtype !== 'success' || msg.is_error
          // 화면에 보여줄 실패 사유(모델이 쓴 result 문구 포함)
          const detail = [
            msg.subtype === 'success' ? (msg.is_error ? msg.result : '') : msg.errors.join(' '),
            apiError
          ]
            .filter(Boolean)
            .join(' ')
          // 인증 분류에는 모델이 생성한 result 텍스트를 넣지 않는다.
          // ("로그인 페이지로 이동했습니다" 같은 정상 요약이 auth:missing 으로 오분류됐다)
          const kind = classifyAuthError(
            [msg.subtype === 'success' ? '' : msg.errors.join(' '), apiError]
              .filter(Boolean)
              .join(' ')
          )
          // assistant 텍스트를 한 번도 못 받았을 때만 최종 결과 문자열을 대신 보여준다
          if (!failed && deduper.count() === 0) {
            const text = deduper.accept(msg.subtype === 'success' ? msg.result : '')
            if (text) emit({ type: 'text', text })
          }
          settled = true
          emit({
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
        emit({
          type: 'status',
          state: 'failed',
          message: kind ? `auth:${kind}` : message,
          toolCalls: counter.count()
        })
      }
    } finally {
      // 이미 stop() 이나 다음 run() 이 상태를 가져갔으면 건드리지 않는다
      if (gen === this.generation) {
        this.abort = null
        this.clearPending()
      }
    }
  }
}
