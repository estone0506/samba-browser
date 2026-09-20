// iframe 안 preload 와 주고받는 AI 동작 채널.
//
// 메인 프레임은 webContents.executeJavaScriptInIsolatedWorld 로 바로 부를 수 있지만,
// 하위 프레임에는 그런 API 가 없다(WebFrameMain.executeJavaScript 는 페이지의 메인 월드에서
// 돌아 격리 월드의 __samba 에 닿지 못하고, 거기에 실행기를 두면 적대 페이지가 가로챈다).
//
// 그래서 프레임 호출은 IPC 로 한다:
//   main --frame.send(page:agentCall {reqId, op, …})--> 그 프레임의 preload(격리 월드)
//   preload 가 자기 document 에서만 실행 --ipcRenderer.send(page:agentResult)--> main
//
// 코드 문자열은 오가지 않는다 — preload 는 미리 정해진 동작 이름만 실행한다.
// 응답은 요청을 보낸 바로 그 프레임에서 온 것만 받는다(다른 프레임이 남의 답을 가로챌 수 없다).

import { ipcMain, type IpcMainEvent, type WebFrameMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AgentOp } from '../../shared/agent-op'

/** 프레임이 답하지 않을 때 기다리는 한도 */
export const FRAME_CALL_TIMEOUT_MS = 8000

interface Pending {
  frame: WebFrameMain
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<number, Pending>()
let seq = 0
let listening = false

/** 응답 짝 맞추기(순수 로직만 떼어 테스트할 수 있게 밖으로 둔다) */
export function settleFrameReply(reqId: number, ok: boolean, value: unknown, from: unknown): void {
  const entry = pending.get(reqId)
  if (!entry) return
  // 물어본 프레임이 답한 것만 받는다
  if (from !== entry.frame) return
  pending.delete(reqId)
  clearTimeout(entry.timer)
  if (ok) entry.resolve(value)
  else entry.reject(new Error('frame call failed'))
}

function listen(): void {
  if (listening) return
  // 테스트 스텁처럼 ipcMain 이 없는 환경에서는 조용히 넘어간다(프레임 호출만 실패한다)
  if (typeof ipcMain?.on !== 'function') return
  listening = true
  ipcMain.on(IPC.pageAgentResult, (event: IpcMainEvent, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return
    const reply = raw as { reqId?: unknown; ok?: unknown; value?: unknown }
    if (typeof reply.reqId !== 'number') return
    settleFrameReply(reply.reqId, reply.ok === true, reply.value, event.senderFrame)
  })
}

/** 프레임 안 preload 에 동작 하나를 맡기고 결과를 기다린다 */
export function callFrameOp(
  frame: WebFrameMain,
  op: AgentOp,
  timeoutMs: number = FRAME_CALL_TIMEOUT_MS
): Promise<unknown> {
  listen()
  seq += 1
  const reqId = seq
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error('frame call timed out'))
    }, timeoutMs)
    pending.set(reqId, { frame, resolve, reject, timer })
    try {
      if (frame.isDestroyed()) throw new Error('frame is gone')
      frame.send(IPC.pageAgentCall, { reqId, ...op })
    } catch (e) {
      pending.delete(reqId)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error('frame call failed'))
    }
  })
}
