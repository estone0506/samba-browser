// 자동화 화면의 순수 표시 로직(React 없음 — 단위 테스트에서 그대로 부른다)

import { PLAYBOOK_TRIGGER_MAX } from '@shared/playbook'

// 카드 접힘 상태에서 보여 줄 절차 미리보기 길이
export const PREVIEW_MAX = 180

/** 트리거 입력줄 → 목록. 쉼표·줄바꿈 어느 쪽으로 나눠도 되게 한다 */
export function parseTriggers(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim().slice(0, PLAYBOOK_TRIGGER_MAX))
    .filter((t) => t !== '')
}

/** 절차 마크다운에서 첫 문단만 잘라 미리보기로 쓴다(제목 줄은 건너뛴다) */
export function previewOf(instructions: string): string {
  const line = instructions
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (line === undefined) return ''
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line
}
