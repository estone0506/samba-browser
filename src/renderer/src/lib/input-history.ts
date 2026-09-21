// 채팅 입력 이력 — 터미널처럼 ↑/↓ 로 이전에 보낸 문장을 다시 꺼낸다.
// 이력은 이 기기의 localStorage 에만 둔다(동기화하지 않는다)

/** 기억하는 문장 수 상한 */
export const INPUT_HISTORY_MAX = 50
const STORAGE_KEY = 'samba.chatInputHistory'

/** 보낸 문장을 이력 끝에 더한다. 빈 문장과 바로 앞과 같은 문장은 넣지 않는다 */
export function addToHistory(list: readonly string[], text: string): string[] {
  const value = text.trim()
  if (value === '' || list[list.length - 1] === value) return [...list]
  return [...list, value].slice(-INPUT_HISTORY_MAX)
}

export interface HistoryCursor {
  /** 지금 보고 있는 이력 위치. list.length 는 "쓰던 글"(이력 밖) 이다 */
  index: number
  /** 이력으로 올라가기 전에 쓰고 있던 글 — ↓ 로 끝까지 내려오면 되돌려 준다 */
  draft: string
}

/**
 * ↑(older) / ↓(newer) 한 번. 움직일 곳이 없으면 null(키 입력을 그대로 흘려보낸다).
 * 처음 ↑ 를 누를 때 쓰던 글을 draft 로 잡아 둔다
 */
export function stepHistory(
  list: readonly string[],
  cursor: HistoryCursor,
  direction: 'older' | 'newer',
  current: string
): { cursor: HistoryCursor; value: string } | null {
  if (list.length === 0) return null
  const atDraft = cursor.index >= list.length
  if (direction === 'older') {
    const index = atDraft ? list.length - 1 : cursor.index - 1
    if (index < 0) return null
    return { cursor: { index, draft: atDraft ? current : cursor.draft }, value: list[index] }
  }
  if (atDraft) return null
  const index = cursor.index + 1
  if (index >= list.length) return { cursor: { index: list.length, draft: '' }, value: cursor.draft }
  return { cursor: { index, draft: cursor.draft }, value: list[index] }
}

/** 이력 밖(쓰던 글) 위치의 커서 */
export function draftCursor(list: readonly string[]): HistoryCursor {
  return { index: list.length, draft: '' }
}

export function loadInputHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((v): v is string => typeof v === 'string').slice(-INPUT_HISTORY_MAX)
  } catch {
    return []
  }
}

export function saveInputHistory(list: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-INPUT_HISTORY_MAX)))
  } catch {
    // 저장소를 못 써도(용량·차단) 입력 자체는 계속된다 — 이번 세션 메모리 이력만 쓴다
  }
}
