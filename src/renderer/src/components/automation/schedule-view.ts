// 예약 카드의 순수 표시 로직(React 없음 — 단위 테스트에서 그대로 부른다).
//
// 화면 문구는 i18n 키와 인자만 돌려주고, 실제 번역은 컴포넌트가 t() 로 한다.
// 그래야 "2시간 후" 같은 문장을 한국어·영어에서 각자 어순대로 쓸 수 있다.

import {
  SCHEDULE_HISTORY_MAX,
  type PlaybookSchedule,
  type ScheduleHistoryEntry,
  type ScheduleKind,
  type SchedulePauseReason,
  type ScheduleResult,
  type ScheduleUiState
} from '@shared/schedule'

/** t(key, params) 에 그대로 넘길 수 있는 문구 한 조각 */
export interface Phrase {
  key: string
  params?: Record<string, string | number>
}

export function kindLabelKey(kind: ScheduleKind): string {
  return `schedule.kind.${kind}`
}

export function stateLabelKey(state: ScheduleUiState): string {
  return `schedule.state.${state}`
}

export function pauseReasonKey(reason: SchedulePauseReason): string {
  return `schedule.pauseReason.${reason}`
}

export function resultLabelKey(result: ScheduleResult): string {
  return `schedule.result.${result}`
}

/** 0=일 ~ 6=토 */
export function weekdayLabelKey(day: number): string {
  return `schedule.weekday.${day}`
}

/**
 * 지금과의 거리를 "2시간 후" / "10분 전" 으로 읽을 문구.
 * 1분 미만은 방향을 따지지 않고 "곧" 으로 뭉갠다
 */
export function relativeTime(target: number, now: number): Phrase {
  const diff = target - now
  const abs = Math.abs(diff)
  const future = diff > 0
  const minutes = Math.round(abs / 60_000)
  if (minutes < 1) return { key: 'schedule.rel.now' }
  if (minutes < 60) {
    return {
      key: future ? 'schedule.rel.inMinutes' : 'schedule.rel.minutesAgo',
      params: { minutes }
    }
  }
  const hours = Math.round(abs / 3_600_000)
  if (hours < 24) {
    return { key: future ? 'schedule.rel.inHours' : 'schedule.rel.hoursAgo', params: { hours } }
  }
  const days = Math.round(abs / 86_400_000)
  return { key: future ? 'schedule.rel.inDays' : 'schedule.rel.daysAgo', params: { days } }
}

/**
 * 예약 규칙 한 조각("매일 09:00", "3시간마다", "월·수 09:00").
 * 요일 이름은 이미 번역된 문자열을 받는다(번역 자체는 컴포넌트가 한다)
 */
export function rulePhrase(schedule: PlaybookSchedule, weekdayNames: string[]): Phrase {
  if (schedule.kind === 'interval') {
    const minutes = schedule.everyMinutes ?? 60
    return minutes % 60 === 0
      ? { key: 'schedule.rule.everyHours', params: { hours: minutes / 60 } }
      : { key: 'schedule.rule.everyMinutes', params: { minutes } }
  }
  if (schedule.kind === 'daily')
    return { key: 'schedule.rule.daily', params: { at: schedule.at ?? '' } }
  if (schedule.kind === 'weekly') {
    return {
      key: 'schedule.rule.weekly',
      params: { days: weekdayNames.join('·'), at: schedule.at ?? '' }
    }
  }
  return { key: 'schedule.rule.manual' }
}

/** 마지막 실행 절대 시각(툴팁·본문용) */
export function formatClock(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 최근 이력 점 하나 */
export interface HistoryMark {
  at: number
  result: ScheduleResult
  /** 성공은 채운 점, 실패·중단은 빈 점 */
  glyph: '●' | '○'
}

/** 최근 10회를 왼쪽이 오래된 순서로 돌려준다 */
export function historyMarks(history: readonly ScheduleHistoryEntry[]): HistoryMark[] {
  return history.slice(-SCHEDULE_HISTORY_MAX).map((entry) => ({
    at: entry.at,
    result: entry.result,
    glyph: entry.result === 'ok' ? ('●' as const) : ('○' as const)
  }))
}

/** 종류를 바꿀 때 그 종류에 필요한 칸을 채워 준다(비어 있으면 기본값) */
export function withKind(schedule: PlaybookSchedule, kind: ScheduleKind): PlaybookSchedule {
  return {
    ...schedule,
    kind,
    // 수동으로 되돌리면 예약 자체가 꺼진다 — 꺼 둔 예약이 남아 헷갈리지 않게 한다
    enabled: kind === 'manual' ? false : schedule.enabled,
    paused: kind === 'manual' ? false : schedule.paused,
    ...(kind === 'manual' ? { pauseReason: undefined } : {})
  }
}
