// AI 채팅 기록 공유 타입. 메인·렌더러 양쪽에서 쓴다.
//
// 비밀값 방어: 메시지에 담기는 것은 사용자가 친 글, AI 가 쓴 글, 그리고 진행 로그의
// **라벨**뿐이다. fill_secret·login 같은 도구는 평문을 라벨에 넣지 않으므로(도구 쪽에서
// 이미 보장한다) 여기서도 label/ok/key 세 칸만 저장한다 — 그 밖의 키는 sanitizeSteps 가 버린다

export type ChatRole = 'user' | 'assistant' | 'system'

export const CHAT_ROLES: readonly ChatRole[] = ['user', 'assistant', 'system']

/** 사이드바에 걸리는 최근 채팅 개수 */
export const RECENT_CHAT_LIMIT = 20

/** 제목을 자동으로 지을 때 잘라 쓰는 첫 메시지 길이 */
export const CHAT_TITLE_MAX = 40

/** 진행 로그 한 줄. 화면의 Step 과 같은 모양이되, 저장되는 칸은 이 셋뿐이다 */
export interface ChatStepDto {
  label: string
  ok: boolean
  /** 번역 키(있으면 화면에서 i18n 문구로 바꿔 보여 준다) */
  key?: string
}

/** 대화 한 줄(목록용) */
export interface ChatDto {
  id: number
  title: string
  createdAt: number
  updatedAt: number
}

/** 메시지 한 줄 */
export interface ChatMessageDto {
  id: number
  chatId: number
  role: ChatRole
  content: string
  steps: ChatStepDto[] | null
  createdAt: number
  updatedAt: number
}

/** 대화 열기 응답 — 대화 정보 + 메시지 전체 */
export interface ChatDetailDto {
  chat: ChatDto
  messages: ChatMessageDto[]
}

/** 메시지 추가 요청 */
export interface AppendMessageInput {
  chatId: number
  role: ChatRole
  content: string
  steps?: ChatStepDto[]
}

export function isChatRole(value: unknown): value is ChatRole {
  return typeof value === 'string' && (CHAT_ROLES as readonly string[]).includes(value)
}

/**
 * 저장 전 진행 로그를 정제한다.
 * 알 수 없는 칸(도구가 덧붙였을 수 있는 값·인자 등)은 전부 버리고 label/ok/key 만 남긴다.
 * 이것이 "스텝 로그에 평문 비밀번호가 들어갈 경로가 없다"는 마지막 방어선이다
 */
export function sanitizeSteps(steps: unknown): ChatStepDto[] | null {
  if (!Array.isArray(steps)) return null
  const rows: ChatStepDto[] = []
  for (const raw of steps) {
    if (typeof raw !== 'object' || raw === null) continue
    const step = raw as Record<string, unknown>
    const label = typeof step.label === 'string' ? step.label : ''
    const key = typeof step.key === 'string' ? step.key : undefined
    rows.push(
      key === undefined ? { label, ok: step.ok === true } : { label, ok: step.ok === true, key }
    )
  }
  return rows
}

/** 첫 사용자 메시지에서 대화 제목을 짓는다. 비어 있으면 호출부가 기본 문구를 쓴다 */
export function titleFromMessage(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > CHAT_TITLE_MAX ? `${line.slice(0, CHAT_TITLE_MAX)}…` : line
}
