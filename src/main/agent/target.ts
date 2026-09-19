import type { Tab, TabManager } from '../browser/tab-manager'
import type { AgentTarget } from '../browser/targets'

// AI 도구가 "지금 조작할 창"을 고르는 한 곳. tools.ts 와 tools-ocr.ts 가 함께 쓰며,
// tools.ts 를 거치지 않으므로 순환 import 가 생기지 않는다

/**
 * AI 가 지금 조작할 대상. switch_tab 으로 팝업(결제창·주소 검색창)을 골랐고 그 창이
 * 아직 살아 있으면 팝업, 아니면 활성 탭이다. 대상이 없으면 null.
 *
 * agentTarget 을 갖추지 않은 대역(오래된 테스트 스텁)은 활성 탭으로 되돌린다
 */
export function agentTargetOf(tabs: TabManager): Tab | null {
  const candidate = tabs as Partial<TabManager>
  if (typeof candidate.agentTarget === 'function') return candidate.agentTarget()
  return tabs.active()
}

/**
 * 탭 + 살아 있는 팝업 전체 목록. listTargets 를 갖추지 않은 대역에서는
 * 탭 목록만으로 같은 모양을 만든다
 */
export function allTargetsOf(tabs: TabManager): AgentTarget[] {
  const candidate = tabs as Partial<TabManager>
  if (typeof candidate.listTargets === 'function') return candidate.listTargets()
  return tabs.list().map((t) => ({
    id: t.id,
    kind: 'tab' as const,
    title: t.title,
    url: t.url,
    active: t.active
  }))
}

/** 살아 있는 팝업만 */
export function popupTargetsOf(tabs: TabManager): AgentTarget[] {
  return allTargetsOf(tabs).filter((t) => t.kind === 'popup')
}

/** 대상 전환. focusTarget 이 없는 대역은 기존 activate 로 되돌린다 */
export function focusTargetOf(tabs: TabManager, id: string): void {
  const candidate = tabs as Partial<TabManager>
  if (typeof candidate.focusTarget === 'function') candidate.focusTarget(id)
  else tabs.activate(id)
}

/** 대상 닫기. closeTarget 이 없는 대역은 기존 close 로 되돌린다 */
export function closeTargetOf(tabs: TabManager, id: string): void {
  const candidate = tabs as Partial<TabManager>
  if (typeof candidate.closeTarget === 'function') candidate.closeTarget(id)
  else tabs.close(id)
}

/**
 * 새로 열린 팝업을 모델에게 알리는 한 줄. 도구 결과 끝에 붙여, 버튼을 눌러 창이 떴는데도
 * "창이 안 열린다"고 판단하던 문제를 막는다
 */
export function popupNotice(target: AgentTarget, host: string): string {
  return (
    `opened popup ${target.id} "${target.title}" (${host}) - ` +
    `call switch_tab("${target.id}") to work inside it`
  )
}
