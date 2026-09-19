// 작업 페이지의 '실행 이력' 만들기 — 두 출처를 한 줄 모양으로 맞춰 시간 역순으로 합친다.
//
//  (a) 예약 실행 기록: 스케줄러가 기기 로컬 파일(userData/schedule-runs.json)에 남긴다.
//      플레이북별 최근 10회의 시각·결과가 들어 있고, 한 줄 요약은 마지막 실행 것만 있다.
//  (b) 채팅 기록: 대화 한 건 = 작업 한 건으로 본다. 제목은 첫 사용자 지시, 요약은 마지막
//      AI 응답의 첫 줄이다(예약 요약과 같은 규칙을 쓰려고 summarize 를 그대로 쓴다).
//
// React 없는 순수 함수라 단위 테스트에서 그대로 부른다. 화면 문구는 여기서 만들지 않는다 —
// 결과·출처는 값으로만 돌려주고 번역은 컴포넌트가 t() 로 한다.

import { summarize, type ScheduleResult, type ScheduleStatusDto } from '@shared/schedule'

/** 목록 한 줄의 제목 길이 상한(첫 사용자 지시를 잘라 쓴다) */
export const TASK_TITLE_MAX = 60
/** '더 보기' 한 번에 늘어나는 줄 수 */
export const TASK_PAGE_SIZE = 50

/** 이 줄이 어디서 왔나. 'schedule' 은 예약이 돌린 것, 'chat' 은 사용자가 직접 시킨 것 */
export type TaskRunSource = 'schedule' | 'chat'

/** 실행 이력 한 줄 */
export interface TaskRun {
  /** 목록 key. 출처가 달라도 겹치지 않게 접두사를 붙인다 */
  key: string
  source: TaskRunSource
  at: number
  title: string
  /** 결과를 알 수 없으면 null(배지를 숨긴다) */
  result: ScheduleResult | null
  summary: string
  /** 눌렀을 때 열 대화. 예약 줄은 어느 대화였는지 기록이 없어 null 이다 */
  chatId: number | null
  playbookId: string | null
}

/** 채팅 한 건에서 뽑아 온 값(대화 목록 + 상세를 합쳐 호출부가 만든다) */
export interface ChatRunInput {
  id: number
  at: number
  /** 첫 사용자 지시. 비어 있으면 대화 제목을 넣어 준다 */
  prompt: string
  /** 마지막 AI 응답 본문 */
  lastText: string
}

/** 첫 줄만 남기고 60자로 자른다(여러 줄 지시가 목록을 밀어내지 않게) */
export function taskTitle(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  return line.length > TASK_TITLE_MAX ? `${line.slice(0, TASK_TITLE_MAX)}…` : line
}

/**
 * 채팅 한 건의 결과 판정.
 * 채팅 기록에는 종료 상태가 따로 저장되지 않는다 — 러너는 완료·실패·중단 어느 쪽으로 끝나도
 * 그때까지의 대화만 남긴다. 그래서 "AI 가 끝내 답을 쓰지 못했으면 중간에 멈춘 것" 으로 읽는다.
 */
export function chatResult(lastText: string): ScheduleResult {
  return lastText.trim() === '' ? 'skipped' : 'ok'
}

/** 예약 실행 기록 → 이력 줄. nameOf 는 플레이북 id 로 이름을 찾아 준다 */
export function scheduleRuns(
  statuses: readonly ScheduleStatusDto[],
  nameOf: (playbookId: string) => string | undefined
): TaskRun[] {
  const out: TaskRun[] = []
  for (const status of statuses) {
    for (const entry of status.history) {
      out.push({
        key: `schedule-${status.playbookId}-${entry.at}`,
        source: 'schedule',
        at: entry.at,
        title: nameOf(status.playbookId) ?? status.playbookId,
        result: entry.result,
        // 요약은 마지막 실행 것만 남아 있다(기록에는 시각·결과만 쌓인다)
        summary: entry.at === status.lastRunAt ? status.lastSummary : '',
        chatId: null,
        playbookId: status.playbookId
      })
    }
  }
  return out
}

/** 채팅 기록 → 이력 줄 */
export function chatRuns(chats: readonly ChatRunInput[]): TaskRun[] {
  return chats.map((chat) => ({
    key: `chat-${chat.id}`,
    source: 'chat',
    at: chat.at,
    title: taskTitle(chat.prompt),
    result: chatResult(chat.lastText),
    summary: summarize(chat.lastText),
    chatId: chat.id,
    playbookId: null
  }))
}

/**
 * 두 출처를 합쳐 시간 역순으로 돌려준다.
 * 같은 시각이면 key 순으로 갈라 순서가 흔들리지 않게 한다(화면이 매번 다르게 보이지 않도록)
 */
export function mergeTaskRuns(...groups: readonly (readonly TaskRun[])[]): TaskRun[] {
  return groups
    .flat()
    .slice()
    .sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 앞에서부터 page 쪽만큼 잘라 준다(page 는 1부터) */
export function pageOf(runs: readonly TaskRun[], page: number): TaskRun[] {
  return runs.slice(0, Math.max(1, page) * TASK_PAGE_SIZE)
}

/** 아직 못 보여 준 줄이 남았는가 */
export function hasMore(runs: readonly TaskRun[], page: number): boolean {
  return runs.length > Math.max(1, page) * TASK_PAGE_SIZE
}
