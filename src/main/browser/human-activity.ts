// 사람이 쓰는 탭에 자동화가 끼어들지 않게 막는다.
//
// 실기 2026-09-25: 사용자가 네이버 로그인 창에서 키마스터 자동로그인을 하는 동안 자동화(login 도구)가
// 같은 칸에 한 글자씩 쳐서 두 입력이 섞였다("snnh6oj7n@4f!@o!rt") — 틀린 로그인이 반복돼 계정이 잠겼다.
//
// 규칙
//  - 탭에 사람의 키 입력(before-input-event)이나 사용자가 누른 키마스터 자동완성이 있으면 그 탭을
//    HUMAN_BUSY_MS 동안 '사람이 쓰는 중'으로 본다.
//  - 자동화(AI 도구·하네스 브릿지)는 그동안 그 탭에 입력·클릭·로그인·비밀값 채우기를 하지 않는다.
//  - 자동화가 스스로 보내는 진짜 키 입력(sendInputEvent)도 before-input-event 를 일으키므로, 자동화 입력 중에는
//    사람 입력으로 세지 않는다(끝난 뒤 이벤트가 늦게 도착하는 것을 위해 여유 시간을 둔다).

import { AsyncLocalStorage } from 'node:async_hooks'
import type { WebContents } from 'electron'

/** 사람이 마지막으로 입력한 뒤 이 시간 동안은 자동화가 그 탭을 건드리지 않는다 */
export const HUMAN_BUSY_MS = 60_000
/** 자동화 입력이 끝난 뒤에도 이만큼은 늦게 도착한 제 키 이벤트를 사람 입력으로 세지 않는다 */
const AUTOMATION_INPUT_TAIL_MS = 800

export const HUMAN_BUSY_REFUSAL =
  'refused: the user is typing in this tab right now (their own sign-in or autofill) — do not type, click or sign in here; wait and try later or ask the user'

const lastHuman = new WeakMap<WebContents, number>()
const automationDepth = new WeakMap<WebContents, number>()
const automationUntil = new WeakMap<WebContents, number>()
const automationScope = new AsyncLocalStorage<true>()

/** 자동화(AI 도구·브릿지 호출) 안에서 fn 을 돌린다 — 그 안의 입력은 '사람이 쓰는 탭' 검사를 받는다 */
export function runAsAutomation<T>(fn: () => Promise<T>): Promise<T> {
  return automationScope.run(true, fn)
}

/** 지금 자동화 흐름 안인가(사용자가 누른 자동완성이면 false) */
export function isAutomation(): boolean {
  return automationScope.getStore() === true
}

/** 사람의 입력을 기록한다(키 입력·사용자가 누른 키마스터 자동완성) */
export function markHuman(wc: WebContents, now = Date.now()): void {
  lastHuman.set(wc, now)
}

/** 키 입력 이벤트가 사람의 것인가 — 자동화가 입력을 보내는 중(과 그 직후)이면 아니다 */
export function isHumanInputEvent(wc: WebContents, now = Date.now()): boolean {
  if ((automationDepth.get(wc) ?? 0) > 0) return false
  return now >= (automationUntil.get(wc) ?? 0)
}

/** 사람이 최근 이 탭을 쓰고 있는가 */
export function humanBusy(wc: WebContents, now = Date.now(), windowMs = HUMAN_BUSY_MS): boolean {
  const at = lastHuman.get(wc)
  return at !== undefined && now - at < windowMs
}

/** 자동화 흐름 안에서 사람이 쓰는 탭을 건드리려 하면 거절 문구, 아니면 null */
export function automationBlocked(wc: WebContents | null | undefined): string | null {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null
  if (!isAutomation()) return null
  return humanBusy(wc) ? HUMAN_BUSY_REFUSAL : null
}

/** 자동화가 이 탭에 진짜 입력(sendInputEvent)을 보내는 동안 감싼다 — 그 이벤트를 사람 입력으로 세지 않게 */
export async function withAutomationInput<T>(wc: WebContents, fn: () => Promise<T>): Promise<T> {
  automationDepth.set(wc, (automationDepth.get(wc) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    automationDepth.set(wc, Math.max(0, (automationDepth.get(wc) ?? 1) - 1))
    automationUntil.set(wc, Date.now() + AUTOMATION_INPUT_TAIL_MS)
  }
}

// --- 기계가 채운 입력(로그인 저장 제안 제외용) --------------------------------
//
// 로그인 자격증명 자동 저장(vault-capture)은 **사람이 친 값**만 받는다. 자동화(AI 도구·하네스 브릿지)나
// 키마스터 자동 채움(피커·fill_secret·login 도구)이 칸에 값을 넣은 뒤의 제출은 이미 금고에 있는 값이거나
// 사람이 확인하지 않은 값이라 저장 제안을 띄우지 않는다. page-bridge 가 값을 넣는 동작마다 여기에 표시한다

/** 기계 입력 뒤 이 시간 안에 온 제출은 사람 것으로 보지 않는다 */
export const MACHINE_FILL_WINDOW_MS = 120_000
/** 기계 입력이 끝난 뒤 이만큼 안의 키 입력은 그 기계 입력의 늦은 이벤트로 본다(사람이 고쳐 친 것으로 보지 않는다) */
export const MACHINE_FILL_TAIL_MS = 1_500

const lastMachine = new WeakMap<WebContents, number>()

/** 기계(자동화·자동 채움)가 이 탭의 칸에 값을 넣었다고 표시한다 */
export function markMachineInput(wc: WebContents, now = Date.now()): void {
  lastMachine.set(wc, now)
}

/**
 * 기계 입력 흔적으로 제출을 사람 것에서 뺄지 판정한다(순수 함수).
 * - 기계 입력이 없거나 오래전(window 밖)이면 사람 제출
 * - 기계 입력 뒤 사람이 다시 쳤으면(늦은 이벤트 여유 tail 을 넘겨) 사람 제출 — 자동 채움 뒤 비밀번호를 고쳐 친 경우
 * - 그 밖에는 기계 제출
 */
export function isMachineSubmission(
  machineAt: number | undefined,
  humanAt: number | undefined,
  now: number,
  windowMs = MACHINE_FILL_WINDOW_MS,
  tailMs = MACHINE_FILL_TAIL_MS
): boolean {
  if (machineAt === undefined || now - machineAt >= windowMs) return false
  if (humanAt !== undefined && humanAt > machineAt + tailMs) return false
  return true
}

/** 이 탭의 지금 제출이 기계가 채운 값의 제출인가 */
export function machineFilledRecently(wc: WebContents, now = Date.now()): boolean {
  return isMachineSubmission(lastMachine.get(wc), lastHuman.get(wc), now)
}
