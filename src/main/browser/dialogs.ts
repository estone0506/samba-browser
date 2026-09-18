// 페이지 JS 대화상자(alert/confirm/prompt) 자동 처리.
//
// 네이티브 대화상자는 렌더러를 멈춰 자동화를 그대로 정지시킨다. 그래서 **작업 실행 중에만**
// CDP 로 대화상자를 즉시 닫고, 무슨 문구였는지는 다음 도구 결과 앞에 붙여 AI 에게 알린다.
// 사람이 브라우저를 직접 쓰는 중(작업 없음)에는 손대지 않는다 — 기본 동작(창 표시) 그대로다.
//
// 판정 로직은 순수 함수로 분리해 electron 없이 테스트한다.

import type { WebContents } from 'electron'
import type { PermissionMode } from '../../shared/settings'
import { ensureDebuggerAttached, keepDebuggerAttached } from './emulation'

// 다음 도구 결과 앞에 붙는 안내의 최대 길이(장문 alert 가 결과를 밀어내지 않게)
const DIALOG_MESSAGE_MAX = 300

export interface DialogDecision {
  // 자동으로 닫을 것인가(false 면 기본 동작 = 사용자에게 창을 보여 준다)
  handle: boolean
  // 확인(true) 인가 취소(false) 인가
  accept: boolean
  // 사용자에게 물어봐야 하는가(guard 모드의 confirm/beforeunload).
  // 물어볼 수단이 없으면 accept 값(= 취소)으로 닫는다
  ask: boolean
}

/**
 * 대화상자 자동 처리 여부를 정한다.
 * - 자동화가 돌고 있지 않으면 절대 건드리지 않는다(사람이 직접 쓰는 중)
 * - prompt 는 임의의 문자열을 입력하게 되므로 취소(dismiss)한다
 * - alert 는 알림일 뿐이라 닫아서(accept) 흐름을 이어 간다
 * - confirm/beforeunload 는 "예" 가 곧 실행·이탈 동의다. full 모드에서만 자동 확인하고,
 *   guard 는 사용자에게 물어보며(수단이 없으면 취소), read_only 는 항상 취소한다
 */
export function decideDialog(
  type: string,
  automationActive: boolean,
  mode: PermissionMode = 'guard'
): DialogDecision {
  if (!automationActive) return { handle: false, accept: false, ask: false }
  if (type === 'prompt') return { handle: true, accept: false, ask: false }
  if (type === 'confirm' || type === 'beforeunload') {
    if (mode === 'full') return { handle: true, accept: true, ask: false }
    return { handle: true, accept: false, ask: mode === 'guard' }
  }
  return { handle: true, accept: true, ask: false }
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

export interface DialogHandlerDeps {
  // 지금 자동화가 돌고 있는가
  isAutomationActive: () => boolean
  // 현재 사용 권한 모드(confirm/beforeunload 자동 확인 여부를 가른다)
  mode: () => PermissionMode
  // guard 모드에서 사용자에게 확인을 받는다. 없으면 취소로 닫는다
  confirm?: (message: string) => Promise<boolean>
  // 자동 처리한 대화상자의 문구(다음 도구 결과에 붙인다)
  onMessage: (message: string) => void
}

/**
 * 탭 하나에 대화상자 감시를 건다. 모바일 에뮬레이션과 같은 디버거를 공유하며,
 * 한 번 걸면 에뮬레이션 해제가 디버거를 떼어내지 않도록 표시해 둔다.
 */
export function installDialogHandler(wc: WebContents, deps: DialogHandlerDeps): void {
  if (!ensureDebuggerAttached(wc)) return
  keepDebuggerAttached(wc)
  wc.debugger.sendCommand('Page.enable').catch((e: unknown) => {
    console.error('Page.enable 실패', e instanceof Error ? e.message : String(e))
  })
  wc.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.javascriptDialogOpening') return
    const p = params as { type?: string; message?: string }
    const decision = decideDialog(p.type ?? 'alert', deps.isAutomationActive(), deps.mode())
    if (!decision.handle) return
    const message = String(p.message ?? '')
    deps.onMessage(message)
    void (async () => {
      // guard 모드의 confirm/beforeunload 는 사용자 승인을 받아야 확인으로 닫는다
      const accept = decision.ask && deps.confirm ? await deps.confirm(message) : decision.accept
      await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept })
    })().catch((e: unknown) => {
      console.error('대화상자 처리 실패', e instanceof Error ? e.message : String(e))
    })
  })
}
