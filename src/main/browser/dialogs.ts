// 페이지 JS 대화상자(alert/confirm/prompt) 자동 처리.
//
// 네이티브 대화상자는 렌더러를 멈춰 자동화를 그대로 정지시킨다. 그래서 **작업 실행 중에만**
// CDP 로 대화상자를 즉시 닫고, 무슨 문구였는지는 다음 도구 결과 앞에 붙여 AI 에게 알린다.
// 사람이 브라우저를 직접 쓰는 중(작업 없음)에는 손대지 않는다 — 기본 동작(창 표시) 그대로다.
//
// 판정 로직은 순수 함수로 분리해 electron 없이 테스트한다.

import type { WebContents } from 'electron'
import { ensureDebuggerAttached, keepDebuggerAttached } from './emulation'

// 다음 도구 결과 앞에 붙는 안내의 최대 길이(장문 alert 가 결과를 밀어내지 않게)
const DIALOG_MESSAGE_MAX = 300

export interface DialogDecision {
  // 자동으로 닫을 것인가(false 면 기본 동작 = 사용자에게 창을 보여 준다)
  handle: boolean
  // 확인(true) 인가 취소(false) 인가
  accept: boolean
}

/**
 * 대화상자 자동 처리 여부를 정한다.
 * - 자동화가 돌고 있지 않으면 절대 건드리지 않는다(사람이 직접 쓰는 중)
 * - prompt 는 임의의 문자열을 입력하게 되므로 취소(dismiss)한다
 * - alert/confirm/beforeunload 는 확인(accept)해서 흐름을 이어 간다
 */
export function decideDialog(type: string, automationActive: boolean): DialogDecision {
  if (!automationActive) return { handle: false, accept: false }
  if (type === 'prompt') return { handle: true, accept: false }
  return { handle: true, accept: true }
}

/**
 * 자동화가 진행 중인지 판정한다.
 * AgentRunner 가 돌고 있거나, e2e 실행(SAMBA_E2E) 중이면 자동 처리 대상이다.
 */
export function isAutomationActive(
  agentRunning: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  return agentRunning || env.SAMBA_E2E === '1' || env.SAMBA_E2E === 'true'
}

/** 도구 결과 앞에 붙일 안내 문구. 값(비밀값)이 섞일 일이 없도록 페이지 문구만 담는다 */
export function formatDialogNote(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim().slice(0, DIALOG_MESSAGE_MAX)
  return `page dialog: "${flat}"`
}

export interface DialogHandlerDeps {
  // 지금 자동화가 돌고 있는가
  isAutomationActive: () => boolean
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
    const decision = decideDialog(p.type ?? 'alert', deps.isAutomationActive())
    if (!decision.handle) return
    deps.onMessage(String(p.message ?? ''))
    wc.debugger
      .sendCommand('Page.handleJavaScriptDialog', { accept: decision.accept })
      .catch((e: unknown) => {
        console.error('대화상자 처리 실패', e instanceof Error ? e.message : String(e))
      })
  })
}
