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
