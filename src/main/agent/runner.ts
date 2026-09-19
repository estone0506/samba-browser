import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
import type { VaultService } from '../vault/service'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import { buildSystemPrompt } from './prompt'
import { runQuery, classifyAuthError, isFatalApiError } from './provider'
import { resolveModel } from '../ai/models'
import { makeCounter } from './counter'
import { createTextDeduper } from './dedupe'
import {
  watchHandoff,
  HANDOFF_TIMEOUT_MS,
  type HandoffResult,
  type HandoffWatchDeps
} from './handoff'

// 확인 요청 응답 대기 상한 30분
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 작업 1건이 남긴 대화 기록. 완료·실패·중단 어느 쪽으로 끝나도 한 번 전달된다.
 * steps 에는 도구가 붙인 **라벨**만 담긴다 — fill_secret·login 은 평문을 라벨에 넣지 않는다
 */
export interface TranscriptEntry {
  prompt: string
  text: string
  steps: { label: string; ok: boolean }[]
}

/** 대화 기록 저장 훅. 주입하지 않으면 아무것도 저장하지 않는다 */
export type TranscriptSink = (chatId: number, entry: TranscriptEntry) => void

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
  // 대화 기록 저장 훅(채팅 저장소). 없으면 기록을 남기지 않는다
  private transcript: TranscriptSink | null = null

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void,
    // 개인정보 금고. 없으면 금고 도구는 잠금으로 동작한다
    private vault?: VaultService
  ) {}

  /** 대화 기록 저장 훅을 붙인다(채팅 저장소). null 이면 기록하지 않는다 */
  setTranscript(sink: TranscriptSink | null): void {
    this.transcript = sink
  }

  /** 지금 작업이 실행 중인가(페이지 대화상자 자동 처리 조건 판정에 쓴다) */
  isRunning(): boolean {
    return this.abort !== null
  }

  /**
   * 사용자 확인 카드를 띄우고 응답을 기다린다(AI 도구·페이지 대화상자 공용).
   * 응답이 없으면 상한 시간 뒤 거부로 처리한다
   */
  requestConfirm(
    action: string,
    kind: 'danger' | 'finish' = 'danger',
    emit: (e: AgentEvent) => void = this.emit
  ): Promise<boolean> {
    const id = randomUUID()
    const reply = this.registerPending(id, CONFIRM_TIMEOUT_MS)
    emit({ type: 'confirm', requestId: id, action, kind })
    return reply
  }

  /**
   * 캡차·2FA 를 사용자에게 넘기고 작업을 일시정지한다.
   * 사용자가 화면에서 직접 처리하면(페이지 이동·징후 소멸) 자동으로 재개하고,
   * 카드 버튼을 누르면 건너뛰기(skipped)/중단(aborted)으로 끝난다.
   * 캡차를 대신 푸는 일은 하지 않는다 — 입력은 언제나 사용자가 한다
   */
  async requestHandoff(
    req: {
      matched: string
      currentUrl: () => string
      stillBlocked: () => Promise<boolean>
      // 테스트에서 폴링 주기·시계를 갈아 끼우기 위한 통로
      watch?: Pick<HandoffWatchDeps, 'sleep' | 'pollMs' | 'timeoutMs'>
    },
    emit: (e: AgentEvent) => void = this.emit
  ): Promise<HandoffResult> {
    const id = randomUUID()
    // 사용자 버튼 응답: true = 건너뛰고 계속, false = 작업 중단
    const reply = this.registerPending(id, HANDOFF_TIMEOUT_MS + 60_000)
    emit({
      type: 'handoff',
      requestId: id,
      kind: 'captcha',
      matched: req.matched,
      url: req.currentUrl()
    })
    let replied = false
    const userOutcome = reply.then((ok): HandoffResult => {
      replied = true
      return { outcome: ok ? 'skipped' : 'aborted', url: req.currentUrl() }
    })
    const watched = watchHandoff({
      currentUrl: req.currentUrl,
      stillBlocked: req.stillBlocked,
      cancelled: () => replied,
      ...req.watch
    }).then((r): HandoffResult | null =>
      r.outcome === 'cancelled' ? null : { outcome: r.outcome, url: r.url }
    )
    // 먼저 끝나는 쪽이 결과가 된다. 감시가 취소(null)면 사용자 응답을 기다린다
    const result = await Promise.race([userOutcome, watched.then((r) => r ?? userOutcome)])
    // 자동 재개·시간 초과로 끝났으면 남은 응답 대기를 정리한다(카드도 닫힌다)
    this.settlePending(id)
    emit({ type: 'handoffDone', requestId: id, outcome: result.outcome })
    return result
  }

  // 응답 대기 1건 등록 — 확인 카드와 넘김 카드가 같은 응답 채널을 쓴다
  private registerPending(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 응답이 없으면 거부 처리
        if (this.pending.delete(id)) resolve(false)
      }, timeoutMs)
      // 대기 타이머가 앱 종료를 막지 않도록 한다
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
    })
  }

  // 아직 남아 있는 대기 1건을 조용히 정리한다(거부로 resolve)
  private settlePending(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(false)
  }

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

  /** chatId 를 주면 이 실행의 대화 기록을 그 대화에 저장한다(완료·실패·중단 모두) */
  async run(prompt: string, chatId?: number): Promise<void> {
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
    // 이 실행이 남길 대화 기록. 화면으로 나가는 이벤트와 같은 값만 모은다(라벨·본문)
    const entry: TranscriptEntry = { prompt, text: '', steps: [] }
    // 이 실행이 최신 세대일 때만 UI 로 이벤트를 보낸다
    const emit = (e: AgentEvent): void => {
      if (gen !== this.generation) return
      if (e.type === 'text') entry.text = entry.text ? `${entry.text}\n${e.text}` : e.text
      if (e.type === 'step') entry.steps.push({ label: e.label, ok: e.ok })
      this.emit(e)
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
      vaultKeepSignedIn: s.vaultKeepSignedIn,
      vaultExcludedHosts: s.vaultExcludedHosts,
      tick: counter.tick,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      confirm: (action, kind = 'danger') => this.requestConfirm(action, kind, emit),
      handoff: (req) => this.requestHandoff(req, emit)
    })
    emit({ type: 'status', state: 'running', toolCalls: 0 })
    try {
      const stream = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(s.language, s.permissionMode),
        // 작업별 모델 표의 '표준' 칸이 기본 실행 모델이다(s.model 은 하위 호환으로만 남는다)
        model: resolveModel(s.taskModels, 'standard', s.aiProvider),
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
      // 중단으로 끝났어도 그때까지의 대화는 남긴다. 저장 실패가 실행을 깨뜨리지는 않는다
      if (chatId !== undefined && this.transcript) {
        try {
          this.transcript(chatId, entry)
        } catch (e: unknown) {
          console.error('대화 기록 저장 실패', e instanceof Error ? e.message : String(e))
        }
      }
    }
  }
}
