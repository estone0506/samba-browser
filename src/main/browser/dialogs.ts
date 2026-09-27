// 페이지 JS 대화상자(alert/confirm/prompt) 자동 처리.
//
// 네이티브 대화상자는 렌더러를 멈춰 자동화를 그대로 정지시킨다. 그래서 작업 실행 중에는
// CDP 로 대화상자를 즉시 닫고, 무슨 문구였는지는 다음 도구 결과 앞에 붙여 AI 에게 알린다.
//
// 작업이 없을 때도 alert 는 아래 경우 자동으로 닫는다(문구만 로그에 남긴다).
//  - 사람이 보고 있지 않은 창(백그라운드 탭·레인/브리지가 열어 둔 탭·포커스 없는 창)
//  - 같은 문구가 짧은 시간에 되풀이될 때(스크립트 루프가 경고창을 수십 개 쌓았다 — 실기 2026-09-26/27)
// 사람이 직접 보고 조작 중인 활성 탭의 alert 만 기본 동작(창 표시)을 유지한다.
// confirm/prompt/beforeunload 는 "예" 가 곧 실행·이탈 동의라, 작업이 없을 때는 여전히 손대지 않는다.
//
// Electron 주의(v39 소스 확인): CDP Page.handleJavaScriptDialog 로 대화상자를 처리해도 Electron 의
// 네이티브 메시지 상자는 닫히지 않는다 — Electron 의 JavaScriptDialogManager 가
// HandleJavaScriptDialog 를 구현하지 않아서다. 페이지는 풀려 다음 alert 를 또 띄우고, 화면에는
// 이미 처리된 상자가 계속 쌓인다(로그엔 '확인' 인데 CDP 대기 대화상자는 0개였던 원인).
// 그래서 CDP 로 처리한 뒤 webContents 의 내부 '-cancel-dialogs' 이벤트로 남은 상자를 닫는다.
//
// 판정 로직은 순수 함수로 분리해 electron 없이 테스트한다.

import type { WebContents } from 'electron'
import type { PermissionMode } from '../../shared/settings'
import { ensureDebuggerAttached, keepDebuggerAttached } from './emulation'

// 다음 도구 결과 앞에 붙는 안내의 최대 길이(장문 alert 가 결과를 밀어내지 않게)
const DIALOG_MESSAGE_MAX = 300
// 같은 문구가 이 시간 안에 다시 뜨면 반복으로 본다
export const DIALOG_REPEAT_WINDOW_MS = 30_000

export interface DialogDecision {
  // 자동으로 닫을 것인가(false 면 기본 동작 = 사용자에게 창을 보여 준다)
  handle: boolean
  // 확인(true) 인가 취소(false) 인가
  accept: boolean
  // 사용자에게 물어봐야 하는가(guard 모드의 confirm/beforeunload).
  // 물어볼 수단이 없으면 accept 값(= 취소)으로 닫는다
  ask: boolean
}

export interface DialogContext {
  // 사람이 지금 이 창을 직접 보고 있는가(포커스를 가진 창의 활성 탭·팝업)
  userFacing: boolean
  // 같은 문구가 짧은 시간 안에 되풀이됐는가
  repeated: boolean
}

const USER_FACING: DialogContext = { userFacing: true, repeated: false }

/**
 * 대화상자 자동 처리 여부를 정한다.
 * - 자동화가 돌지 않을 때: alert 만, 사람이 보고 있지 않은 창이거나 반복이면 닫는다.
 *   그 밖(사람이 조작 중인 활성 탭의 alert, 모든 confirm/prompt/beforeunload)은 건드리지 않는다
 * - prompt 는 임의의 문자열을 입력하게 되므로 취소(dismiss)한다
 * - alert 는 알림일 뿐이라 닫아서(accept) 흐름을 이어 간다
 * - confirm/beforeunload 는 "예" 가 곧 실행·이탈 동의다. full 모드에서만 자동 확인하고,
 *   guard 는 사용자에게 물어보며(수단이 없으면 취소), read_only 는 항상 취소한다
 */
export function decideDialog(
  type: string,
  automationActive: boolean,
  mode: PermissionMode = 'guard',
  context: DialogContext = USER_FACING
): DialogDecision {
  if (!automationActive) {
    if (type === 'alert' && (!context.userFacing || context.repeated)) {
      return { handle: true, accept: true, ask: false }
    }
    return { handle: false, accept: false, ask: false }
  }
  if (type === 'prompt') return { handle: true, accept: false, ask: false }
  if (type === 'confirm' || type === 'beforeunload') {
    if (mode === 'full') return { handle: true, accept: true, ask: false }
    return { handle: true, accept: false, ask: mode === 'guard' }
  }
  return { handle: true, accept: true, ask: false }
}

/**
 * 같은 문구의 대화상자가 짧은 시간에 되풀이되는지 센다(모든 탭 공통 — 루프는 탭을 가리지 않는다).
 * note() 는 이번 문구가 반복인지 돌려주고 시각을 기록한다.
 */
export class DialogRepeatTracker {
  private lastSeen = new Map<string, number>()

  constructor(private readonly windowMs = DIALOG_REPEAT_WINDOW_MS) {}

  note(message: string, now = Date.now()): boolean {
    const key = message.replace(/\s+/g, ' ').trim()
    // 오래된 기록은 버린다(맵이 끝없이 자라지 않게)
    for (const [k, at] of this.lastSeen) {
      if (now - at >= this.windowMs) this.lastSeen.delete(k)
    }
    const prev = this.lastSeen.get(key)
    this.lastSeen.set(key, now)
    return prev !== undefined && now - prev < this.windowMs
  }
}

/**
 * 자동화가 진행 중인지 판정한다.
 * AgentRunner 가 돌고 있거나, e2e 실행(SAMBA_E2E) 중이면 자동 처리 대상이다.
 * 환경변수 경로는 개발 빌드에서만 인정한다(allowE2eEnv = !app.isPackaged).
 */
export function isAutomationActive(
  agentRunning: boolean,
  env: Record<string, string | undefined> = process.env,
  allowE2eEnv = true
): boolean {
  if (agentRunning) return true
  if (!allowE2eEnv) return false
  return env.SAMBA_E2E === '1' || env.SAMBA_E2E === 'true'
}

/** 도구 결과 앞에 붙일 안내 문구. 값(비밀값)이 섞일 일이 없도록 페이지 문구만 담는다 */
export function formatDialogNote(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim().slice(0, DIALOG_MESSAGE_MAX)
  return `page dialog: "${flat}"`
}

/** 로그에 남길 처리 결과 한마디 */
export function describeDecision(
  decision: DialogDecision,
  automationActive: boolean,
  context: DialogContext
): string {
  if (!decision.handle) return automationActive ? '미처리' : '미처리(사용자가 보는 창)'
  const verb = decision.ask ? '질문' : decision.accept ? '확인' : '취소'
  if (automationActive) return verb
  return `${verb}(${context.repeated ? '반복' : '보고 있지 않은 창'})`
}

// 모든 탭·팝업이 함께 쓰는 반복 감지기
const sharedRepeats = new DialogRepeatTracker()

/**
 * Electron 이 띄운 네이티브 메시지 상자를 닫는다(CDP 처리 뒤 남은 상자 정리).
 * '-cancel-dialogs' 는 Electron 내부 이벤트로, 그 webContents 의 열린 상자를 모두 abort 한다
 * (abort 된 상자는 페이지 콜백을 다시 부르지 않는다). 창이 아직 만들어지기 전이면 만들어지자마자 닫힌다.
 */
export function closeNativeDialogs(wc: WebContents): void {
  if (wc.isDestroyed()) return
  const emitter = wc as unknown as NodeJS.EventEmitter
  emitter.emit('-cancel-dialogs', { resetState: false })
}

export interface DialogHandlerDeps {
  // 지금 자동화가 돌고 있는가
  isAutomationActive: () => boolean
  // 사람이 지금 이 창을 직접 보고 있는가(없으면 그렇다고 본다 = 예전 동작)
  isUserFacing?: () => boolean
  // 현재 사용 권한 모드(confirm/beforeunload 자동 확인 여부를 가른다)
  mode: () => PermissionMode
  // guard 모드에서 사용자에게 확인을 받는다. 없으면 취소로 닫는다
  confirm?: (message: string) => Promise<boolean>
  // 자동 처리한 대화상자의 문구(다음 도구 결과에 붙인다). 자동화 중일 때만 부른다
  onMessage: (message: string) => void
  // 반복 감지기(테스트 주입용). 없으면 모든 창이 공유하는 것을 쓴다
  repeats?: DialogRepeatTracker
}

/**
 * 탭 하나에 대화상자 감시를 건다. 모바일 에뮬레이션과 같은 디버거를 공유하며,
 * 한 번 걸면 에뮬레이션 해제가 디버거를 떼어내지 않도록 표시해 둔다.
 */
export function installDialogHandler(wc: WebContents, deps: DialogHandlerDeps): void {
  if (!ensureDebuggerAttached(wc)) {
    // 붙지 못하면 그 창의 alert 는 네이티브 창으로 떠서 작업을 멈춘다 — 원인을 남긴다(실기: 팝업 alert 미처리 조사)
    console.error('대화상자 감시 설치 실패(디버거 미부착)', wc.getURL().slice(0, 80))
    return
  }
  keepDebuggerAttached(wc)
  wc.debugger.sendCommand('Page.enable').catch((e: unknown) => {
    console.error('Page.enable 실패', e instanceof Error ? e.message : String(e))
  })
  const repeats = deps.repeats ?? sharedRepeats
  wc.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.javascriptDialogOpening') return
    const p = params as { type?: string; message?: string }
    const type = p.type ?? 'alert'
    const message = String(p.message ?? '')
    const automation = deps.isAutomationActive()
    const context: DialogContext = {
      userFacing: deps.isUserFacing ? safeBool(deps.isUserFacing) : true,
      repeated: repeats.note(message)
    }
    const decision = decideDialog(type, automation, deps.mode(), context)
    // 어떤 대화상자를 어떻게 처리했는지 기록한다(문구 앞 60자만 — 비밀값이 섞일 일은 없다).
    // 어느 사이트·경로에서 떴는지도 남긴다(쿼리는 빼서 주문번호 같은 값이 남지 않게)
    console.info(
      `페이지 대화상자 ${type} ${describeDecision(decision, automation, context)}: ${message.slice(0, 60)} @ ${pageWhere(wc)}`
    )
    if (!decision.handle) return
    if (automation) deps.onMessage(message)
    // CDP 로 처리해도 Electron 네이티브 상자는 남는다 — 지금 한 번, 상자가 막 뜬 직후 한 번 닫는다
    closeNativeDialogs(wc)
    setImmediate(() => closeNativeDialogs(wc))
    void (async () => {
      // guard 모드의 confirm/beforeunload 는 사용자 승인을 받아야 확인으로 닫는다
      const accept = decision.ask && deps.confirm ? await deps.confirm(message) : decision.accept
      if (wc.isDestroyed()) return
      await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept })
    })()
      .catch((e: unknown) => {
        console.error('대화상자 처리 실패', e instanceof Error ? e.message : String(e))
      })
      .finally(() => closeNativeDialogs(wc))
  })
}

/** 로그용 페이지 위치 — 호스트와 경로만(쿼리·해시는 버린다) */
export function pageWhere(wc: Pick<WebContents, 'getURL'>): string {
  try {
    const u = new URL(wc.getURL())
    return `${u.host}${u.pathname}`.slice(0, 80)
  } catch {
    return '?'
  }
}

/** 판정기가 던져도 대화상자 처리가 멈추지 않게 — 실패하면 '보고 있다'(= 예전 동작)로 본다 */
function safeBool(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return true
  }
}
