// 확장 프로그램 화면의 검색·정렬·권한 요약 순수 로직.
// React 를 import 하지 않는 순수 모듈이라 그대로 테스트할 수 있다

import type { ExtensionDto } from '@shared/extensions'

/** 확장 페이지 좌측 소메뉴 */
export const EXTENSION_MENUS = ['mine', 'shortcuts'] as const
export type ExtensionMenu = (typeof EXTENSION_MENUS)[number]

export const DEFAULT_EXTENSION_MENU: ExtensionMenu = 'mine'

export function isExtensionMenu(v: unknown): v is ExtensionMenu {
  return typeof v === 'string' && (EXTENSION_MENUS as readonly string[]).includes(v)
}

/**
 * 검색어 정규화.
 * 사용자가 앞뒤 공백을 넣거나 대문자로 쳐도 같은 결과가 나오게 맞춘다
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * 확장 한 개가 검색어와 맞는지.
 * 이름·설명·id 중 하나라도 걸리면 맞는 것으로 본다. 경로는 보지 않는다 —
 * 앱 데이터 폴더 경로에는 모든 확장이 공유하는 부분이 있어 검색이 무의미해진다
 */
export function matchesQuery(item: ExtensionDto, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  return (
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.id.toLowerCase().includes(q)
  )
}

/** 검색어로 거른 목록. 빈 검색어면 원본 순서 그대로 전부 돌려준다 */
export function filterExtensions(items: readonly ExtensionDto[], query: string): ExtensionDto[] {
  return items.filter((item) => matchesQuery(item, query))
}

/**
 * 화면에 보여 줄 순서 — 이름 가나다·알파벳순.
 * 이름이 같으면 id 로 갈라 매번 같은 순서가 나오게 한다(설치 순서는 사용자에게 의미가 없다)
 */
export function sortExtensions(items: readonly ExtensionDto[]): ExtensionDto[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id))
}

/** 세부정보에 보여 줄 권한 목록 — 중복을 없애고 순서를 지킨다 */
export function permissionSummary(permissions: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of permissions) {
    const trimmed = p.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 주소창 툴바에 고정한 확장 id 목록을 토글한다.
 * 고정은 이 기기에서 툴바를 어떻게 보여 줄지에 대한 것이라 동기화하지 않는다
 */
export function togglePinned(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]
}

/**
 * 예전 버전이 localStorage 에 남겨 둔 고정 목록을 설정으로 한 번만 옮긴다.
 *
 * 옮길 것이 없으면(예전 값이 없거나, 설정에 이미 값이 있으면) null 을 돌려준다 —
 * 호출한 쪽은 null 이면 설정을 건드리지 않는다. 설정 쪽을 언제나 이긴 것으로 두는 이유는,
 * 사용자가 새 버전에서 고정을 모두 풀었을 때 예전 값이 되살아나면 안 되기 때문이다
 */
export function migratePinned(
  saved: readonly string[],
  legacy: readonly string[]
): string[] | null {
  if (saved.length > 0) return null
  const merged = [...new Set(legacy.filter((id) => typeof id === 'string' && id.length > 0))]
  return merged.length > 0 ? merged : null
}

/**
 * 툴바에 실제로 그릴 확장들 — 고정한 id 순서대로, 지금 설치돼 있고 켜져 있는 것만.
 * 목록에서 사라졌거나 꺼 둔 확장은 고정돼 있어도 그리지 않는다(크롬과 같다)
 */
export function pinnedExtensions(
  items: readonly ExtensionDto[],
  pinned: readonly string[]
): ExtensionDto[] {
  const byId = new Map(items.map((e) => [e.id, e]))
  const out: ExtensionDto[] = []
  for (const id of pinned) {
    const item = byId.get(id)
    if (item && item.enabled) out.push(item)
  }
  return out
}

/** 고정한 확장을 위로 올린다. 같은 무리 안에서는 들어온 순서를 지킨다 */
export function sortWithPinned(
  items: readonly ExtensionDto[],
  pinned: readonly string[]
): ExtensionDto[] {
  const isPinned = (e: ExtensionDto): boolean => pinned.includes(e.id)
  return [...items.filter(isPinned), ...items.filter((e) => !isPinned(e))]
}

/** 저장해 둔 고정 목록을 읽는다. 값이 깨져 있으면 빈 목록으로 본다 */
export function parsePinned(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 출처 배지의 i18n 키 */
export function sourceLabelKey(source: ExtensionDto['source']): string {
  return source === 'store'
    ? 'extensions.sourceStore'
    : source === 'imported'
      ? 'extensions.sourceImported'
      : 'extensions.sourceFolder'
}
