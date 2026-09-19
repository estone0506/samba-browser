// 사이드바(접기·섹션·열린 탭 줄)의 순수 계산만 모아 둔 곳.
// React 를 쓰지 않으므로 그대로 단위 테스트할 수 있다

import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_SECTION_KEYS,
  type SidebarSectionKey,
  type SidebarSections
} from '@shared/settings'
import { normalizeHost } from '@shared/host'
import { isHttpUrl } from '@shared/url'

export { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_SECTION_KEYS }
export type { SidebarSectionKey, SidebarSections }

/** 접힌 사이드바는 사용자가 끌어 둔 폭과 무관하게 아이콘 폭으로 고정된다 */
export function sidebarWidthOf(collapsed: boolean, width: number): number {
  return collapsed ? SIDEBAR_COLLAPSED_WIDTH : width
}

/** 폭 조절 손잡이는 펼친 상태에서만 쓸 수 있다(접힌 폭은 고정) */
export function canResizeSidebar(collapsed: boolean): boolean {
  return !collapsed
}

/** 값이 없거나 망가진 섹션은 펼침으로 본다 — 사용자가 내용을 잃어버리지 않게 */
export function isSectionOpen(
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): boolean {
  return sections?.[key] !== false
}

/** 섹션 하나만 뒤집은 새 객체를 돌려준다(원본은 그대로 둔다) */
export function toggleSection(
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): SidebarSections {
  const next = {} as SidebarSections
  for (const k of SIDEBAR_SECTION_KEYS) next[k] = isSectionOpen(sections, k)
  next[key] = !next[key]
  return next
}

/**
 * 접힌 사이드바에서는 섹션 내용이 보이지 않으므로, 섹션이 펼쳐져 있어도 본문을 그리지 않는다.
 * (접기를 풀면 원래 펼침 상태가 그대로 돌아온다)
 */
export function showSectionBody(
  collapsed: boolean,
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): boolean {
  return !collapsed && isSectionOpen(sections, key)
}

/** 열린 탭 줄에 쓸 파비콘 호스트. http(s) 가 아니면(새 탭·빈 페이지) 빈 문자열 */
export function tabFaviconHost(url: string): string {
  if (!isHttpUrl(url)) return ''
  const host = normalizeHost(url)
  return host
}

/** 열린 탭 줄에 보여 줄 제목. 제목이 비면 주소로, 그것도 비면 넘겨받은 기본 문구로 떨어진다 */
export function tabRowLabel(tab: { title: string; url: string }, fallback: string): string {
  return tab.title.trim() || tab.url.trim() || fallback
}
