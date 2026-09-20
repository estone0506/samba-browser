// 추천 카드의 순수 표시 로직(React 없음 — 단위 테스트에서 그대로 부른다).
//
// 문구는 i18n 키와 인자만 돌려주고 번역은 컴포넌트가 t() 로 한다.
// 요일 이름은 예약 카드의 것(schedule.weekday.N)을 그대로 쓴다 — 두 화면의 말이 달라지지 않게

import type { RecommendDto } from '@shared/activity-patterns'
import type { Phrase } from './schedule-view'

/** 카드 한 장의 권유 문장 */
export function sentenceOf(candidate: RecommendDto, weekdayLabel = ''): Phrase {
  const base = { label: candidate.label, days: candidate.spanDays, count: candidate.count }
  if (candidate.kind === 'weekly' && candidate.at !== undefined) {
    return {
      key: 'recommend.weekly',
      params: { ...base, time: candidate.at, weekday: weekdayLabel }
    }
  }
  if (candidate.kind === 'daily' && candidate.at !== undefined) {
    return { key: 'recommend.daily', params: { ...base, time: candidate.at } }
  }
  return { key: 'recommend.frequent', params: base }
}

/**
 * 기본 버튼의 i18n 키. null 이면 권할 행동이 없다 —
 * 시각이 흩어진 데다 플레이북도 이미 있으면 새로 만들 것이 없기 때문이다
 */
export function actionKeyOf(candidate: RecommendDto): string | null {
  if (candidate.kind === 'daily' || candidate.kind === 'weekly') return 'recommend.action.create'
  if (candidate.playbookId === undefined) return 'recommend.action.savePlaybook'
  return null
}

/** 카드 맨 위 한 줄 요약 — "매일 09:00 · 플레이북 이름" 처럼 종류·시각·대상만 */
export function summaryOf(candidate: RecommendDto, weekdayLabel = ''): Phrase {
  const base = { label: candidate.label }
  if (candidate.kind === 'daily')
    return { key: 'recommend.summary.daily', params: { ...base, time: candidate.at ?? '' } }
  if (candidate.kind === 'weekly') {
    return {
      key: 'recommend.summary.weekly',
      params: { ...base, time: candidate.at ?? '', weekday: weekdayLabel }
    }
  }
  return { key: 'recommend.summary.frequent', params: base }
}
