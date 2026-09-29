// 자동화가 사람이 보고 있는 화면(보이는 탭·창 포커스)을 빼앗지 않게 하는 판정 — 순수 함수만 둔다.
//
// 실기 2026-09-27: 사용자가 로그인하는 동안 브리지 작업(레인 없는 new_tab·switch_tab, run_js 의 tabs.switch,
// 레인 탭 생성)이 앱 창의 보이는 탭을 바꾸고 결제·로그인 팝업 창에 포커스를 가져가, 사용자가 로그인을 못 했다.
//
// 규칙
//  - 사람이 최근(HUMAN_BUSY_MS) 이 창(창의 어느 탭·팝업이든)에 키를 치거나 마우스를 눌렀으면,
//    자동화 흐름(runAsAutomation 안)은 보이는 탭을 바꾸지 않고 창에 포커스도 주지 않는다.
//  - 그때 자동화가 고른 탭은 '자동화 대상 탭'(내부 표식)으로만 기억한다 — AI 도구는 그 탭을 조작하고
//    화면은 사람이 보던 탭 그대로다.
//  - 사람이 입력하지 않은 지 HUMAN_BUSY_MS 가 지났거나, 자동화가 아닌 흐름(사용자가 탭을 누름)이면 예전처럼 전환한다.

import { HUMAN_BUSY_MS } from './human-activity'

/**
 * 보이는 탭 전환·창 포커스를 막아야 하는가.
 * automation: 지금 자동화 흐름 안인가 / lastHumanAt: 이 창에 사람이 마지막으로 입력한 시각(없으면 undefined)
 */
export function shouldHoldVisible(
  automation: boolean,
  lastHumanAt: number | undefined,
  now: number,
  busyMs = HUMAN_BUSY_MS
): boolean {
  if (!automation) return false
  if (lastHumanAt === undefined) return false
  return now - lastHumanAt < busyMs
}

/**
 * 자동화가 조작할 탭 id. 자동화 대상 탭 표식이 살아 있는 탭을 가리키면 그 탭, 아니면 보이는(활성) 탭이다.
 * 표식이 가리키던 탭이 닫혔으면 보이는 탭으로 돌아간다
 */
export function pickWorkingTabId(
  automationTabId: string | null,
  aliveTabIds: readonly string[],
  activeId: string | null
): string | null {
  if (automationTabId !== null && aliveTabIds.includes(automationTabId)) return automationTabId
  return activeId
}

/** 마우스 이벤트 중 사람 입력으로 셀 것 — 누름만 센다(이동·휠·떼기는 읽기 동작이라 세지 않는다) */
export function isHumanMouseInput(type: string): boolean {
  return type === 'mouseDown'
}

/**
 * 페이지가 새 탭을 열 때(target=_blank·window.open) 뒤에서 열어야 하는가.
 * 보이지 않는 탭(자동화가 뒤에서 조작하는 탭)이 연 탭은 보이는 탭을 덮지 않게 뒤에서 연다
 */
export function openInBackground(openerId: string, activeId: string | null): boolean {
  return activeId !== null && openerId !== activeId
}
