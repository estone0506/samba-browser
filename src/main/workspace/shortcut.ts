// Ctrl+Alt+1~9 작업공간 전환 단축키 판정. 전역 단축키(globalShortcut)가 아니라
// 창의 before-input-event 로만 쓰므로 다른 앱의 단축키를 뺏지 않는다.

import { MAX_WORKSPACES } from './service'

/** before-input-event 가 주는 값 중 판정에 필요한 부분만 */
export interface ShortcutInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * Ctrl+Alt+1~9 이면 1~9 를, 아니면 null 을 돌려준다.
 * Shift·Cmd 가 함께 눌리면 다른 단축키이므로 받지 않는다.
 */
export function workspaceShortcutIndex(input: ShortcutInput): number | null {
  if (input.type !== 'keyDown') return null
  if (!input.control || !input.alt || input.shift || input.meta) return null
  if (!/^[1-9]$/.test(input.key)) return null
  const index = Number(input.key)
  return index <= MAX_WORKSPACES ? index : null
}
