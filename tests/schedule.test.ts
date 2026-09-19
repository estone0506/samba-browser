// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SCHEDULE,
  SCHEDULE_HISTORY_MAX,
  SCHEDULE_PERMISSION_MODES,
  armKeyOf,
  dueAt,
  emptyRecord,
  intervalNextFrom,
  isArmed,
  nextOccurrence,
  normalizeSchedule,
  overridesOf,
  parseHhmm,
  previousOccurrence,
  pushHistory,
  scheduleOf,
  snapInterval,
  summarize,
  upcomingRunAt,
  type PlaybookSchedule,
  type ScheduleState
} from '@shared/schedule'
import { playbookSchema } from '@shared/playbook'
import { PERMISSION_MODES } from '@shared/settings'
import { SYNCED_SETTING_KEYS } from '@shared/sync'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'
import {
  historyMarks,
  kindLabelKey,
  pauseReasonKey,
  relativeTime,
  resultLabelKey,
  rulePhrase,
  stateLabelKey,
  weekdayLabelKey,
  withKind
} from '@renderer/components/automation/schedule-view'

/** 로컬 시각을 그대로 읽어 밀리초로 (테스트가 표준시대에 묶이지 않게 한다) */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

function state(partial: Partial<ScheduleState> = {}): ScheduleState {
  return { armedAt: 0, lastRunAt: null, nextRunAt: null, ...partial }
}

const daily = (time: string): PlaybookSchedule =>
  normalizeSchedule({ enabled: true, kind: 'daily', at: time, paused: false })

const weekly = (time: string, weekdays: number[]): PlaybookSchedule =>
  normalizeSchedule({ enabled: true, kind: 'weekly', at: time, weekdays, paused: false })

const interval = (minutes: number): PlaybookSchedule =>
  normalizeSchedule({ enabled: true, kind: 'interval', everyMinutes: minutes, paused: false })

describe('예약 설정 다듬기', () => {
  it('종류에 맞지 않는 칸은 남기지 않는다', () => {
    const s = normalizeSchedule({
      enabled: true,
      kind: 'daily',
      at: '09:00',
      everyMinutes: 30,
      weekdays: [1, 2],
      paused: false
    })
    expect(s.everyMinutes).toBeUndefined()
    expect(s.weekdays).toBeUndefined()
    expect(s.at).toBe('09:00')
  })

  it('수동으로 되돌리면 예약 자체가 꺼진다', () => {
    const s = normalizeSchedule({ enabled: true, kind: 'manual', paused: false })
    expect(s.enabled).toBe(false)
    expect(isArmed(s)).toBe(false)
  })

  it('망가진 시각·요일은 기본값으로 채운다', () => {
    expect(daily('25:99').at).toBe('09:00')
    expect(weekly('09:00', []).weekdays).toEqual([1, 2, 3, 4, 5])
    expect(weekly('09:00', [3, 1, 3, 9]).weekdays).toEqual([1, 3])
  })

  it('모르는 주기는 가장 가까운 허용 주기로 맞춘다', () => {
    expect(snapInterval(17)).toBe(15)
    expect(snapInterval(1000)).toBe(720)
    expect(snapInterval(undefined)).toBe(60)
  })

  it('빈 모델 이름은 "전역 설정 따름"과 같다', () => {
    expect(normalizeSchedule({ ...daily('09:00'), model: '   ' }).model).toBeUndefined()
    expect(overridesOf(daily('09:00'))).toBeUndefined()
    expect(overridesOf({ ...daily('09:00'), model: 'claude-opus-5' })).toEqual({
      model: 'claude-opus-5'
    })
  })

  it('시각 문자열은 24시간 형식만 받는다', () => {
    expect(parseHhmm('00:00')).toBe(0)
    expect(parseHhmm('23:59')).toBe(23 * 60 + 59)
    expect(parseHhmm('9:00')).toBeNull()
    expect(parseHhmm(undefined)).toBeNull()
  })
})

describe('매일 예약의 예정 시각', () => {
  it('오늘 시각이 지났으면 다음은 내일이다', () => {
    const s = daily('09:00')
    const now = at(2026, 3, 10, 10, 0)
    expect(previousOccurrence(s, now)).toBe(at(2026, 3, 10, 9, 0))
    expect(nextOccurrence(s, now)).toBe(at(2026, 3, 11, 9, 0))
  })

  it('자정을 넘겨도 어제 것을 제대로 집는다', () => {
    const s = daily('00:30')
    const now = at(2026, 3, 10, 0, 10)
    expect(previousOccurrence(s, now)).toBe(at(2026, 3, 9, 0, 30))
    expect(nextOccurrence(s, now)).toBe(at(2026, 3, 10, 0, 30))
  })

  it('달이 바뀌는 자리도 이어진다', () => {
    const s = daily('23:30')
    const now = at(2026, 4, 1, 0, 10)
    expect(previousOccurrence(s, now)).toBe(at(2026, 3, 31, 23, 30))
  })
})

describe('매주 예약의 예정 시각', () => {
  // 2026-03-11 은 수요일이다
  it('고른 요일만 센다', () => {
    const s = weekly('09:00', [1, 3]) // 월·수
    const wed = at(2026, 3, 11, 12, 0)
    expect(previousOccurrence(s, wed)).toBe(at(2026, 3, 11, 9, 0))
    expect(nextOccurrence(s, wed)).toBe(at(2026, 3, 16, 9, 0)) // 다음 월요일
  })

  it('주말만 골라도 주를 건너뛰어 찾는다', () => {
    const s = weekly('09:00', [0, 6]) // 일·토
    const wed = at(2026, 3, 11, 12, 0)
    expect(nextOccurrence(s, wed)).toBe(at(2026, 3, 14, 9, 0)) // 토요일
    expect(previousOccurrence(s, wed)).toBe(at(2026, 3, 8, 9, 0)) // 지난 일요일
  })

  it('요일이 하나도 없으면 돌지 않는다', () => {
    const s: PlaybookSchedule = {
      enabled: true,
      kind: 'weekly',
      at: '09:00',
      weekdays: [],
      paused: false
    }
    expect(previousOccurrence(s, at(2026, 3, 11, 12, 0))).toBeNull()
    expect(nextOccurrence(s, at(2026, 3, 11, 12, 0))).toBeNull()
  })
})

describe('지금 돌 때가 됐는가', () => {
  it('한 번도 안 돌았으면 지난 예정은 따라잡지 않는다', () => {
    const s = daily('09:00')
    const now = at(2026, 3, 10, 10, 0)
    // 예약을 켠 시각이 오늘 09시보다 뒤라면 오늘 09시 건은 이미 지나간 것이다
    expect(dueAt(s, state({ armedAt: at(2026, 3, 10, 9, 30) }), now)).toBeNull()
  })

  it('앱이 꺼져 있던 동안 놓친 매일 예약은 한 번만 따라잡는다', () => {
    const s = daily('09:00')
    const now = at(2026, 3, 10, 10, 0)
    const missed = state({ armedAt: at(2026, 3, 7), lastRunAt: at(2026, 3, 8, 9, 0) })
    // 8일·9일·10일 세 건이 밀렸지만 돌려주는 것은 가장 최근 한 건뿐이다
    expect(dueAt(s, missed, now)).toBe(at(2026, 3, 10, 9, 0))
    // 돌고 나면 더 밀린 것이 없다
    expect(dueAt(s, { ...missed, lastRunAt: now }, now)).toBeNull()
  })

  it('매주 예약도 같은 식으로 한 번만 따라잡는다', () => {
    const s = weekly('09:00', [1]) // 월요일
    const now = at(2026, 3, 11, 12, 0) // 수요일
    const missed = state({ armedAt: at(2026, 2, 1), lastRunAt: at(2026, 3, 2, 9, 0) })
    expect(dueAt(s, missed, now)).toBe(at(2026, 3, 9, 9, 0)) // 이번 주 월요일
  })

  it('간격 예약은 다음 실행 시각을 지나야 돈다', () => {
    const s = interval(60)
    const now = at(2026, 3, 10, 10, 0)
    expect(dueAt(s, state({ nextRunAt: now + 60_000 }), now)).toBeNull()
    expect(dueAt(s, state({ nextRunAt: now }), now)).toBe(now)
    // 기준이 없으면(예약을 막 켠 참) 돌지 않는다
    expect(dueAt(s, state(), now)).toBeNull()
  })

  it('일시정지·꺼짐·수동은 아무리 시간이 지나도 돌지 않는다', () => {
    const now = at(2026, 3, 10, 10, 0)
    const armed = state({ armedAt: at(2026, 3, 1) })
    expect(dueAt({ ...daily('09:00'), paused: true }, armed, now)).toBeNull()
    expect(dueAt({ ...daily('09:00'), enabled: false }, armed, now)).toBeNull()
    expect(dueAt(DEFAULT_SCHEDULE, armed, now)).toBeNull()
  })
})

describe('화면에 보여 줄 다음 실행 시각', () => {
  it('밀린 것이 있으면 그 시각을, 아니면 앞으로의 예정을 보여 준다', () => {
    const s = daily('09:00')
    const now = at(2026, 3, 10, 10, 0)
    expect(
      upcomingRunAt(s, state({ armedAt: at(2026, 3, 1), lastRunAt: at(2026, 3, 8, 9, 0) }), now)
    ).toBe(at(2026, 3, 10, 9, 0))
    expect(upcomingRunAt(s, state({ armedAt: at(2026, 3, 10, 9, 30) }), now)).toBe(
      at(2026, 3, 11, 9, 0)
    )
  })

  it('예약이 꺼져 있으면 없다', () => {
    expect(upcomingRunAt(DEFAULT_SCHEDULE, state(), at(2026, 3, 10))).toBeNull()
  })

  it('간격 예약의 다음 시각은 기준 + 주기다', () => {
    const now = at(2026, 3, 10, 10, 0)
    expect(intervalNextFrom(interval(180), now)).toBe(now + 180 * 60_000)
  })
})

describe('설정이 바뀌면 기준을 다시 잡는다', () => {
  it('시각·주기·요일이 바뀌면 표식이 달라진다', () => {
    expect(armKeyOf(daily('09:00'))).not.toBe(armKeyOf(daily('14:00')))
    expect(armKeyOf(weekly('09:00', [1]))).not.toBe(armKeyOf(weekly('09:00', [2])))
    expect(armKeyOf(interval(60))).not.toBe(armKeyOf(interval(180)))
  })

  it('실행에 영향 없는 칸(모델·일시정지)은 표식을 바꾸지 않는다', () => {
    const base = daily('09:00')
    expect(armKeyOf({ ...base, model: 'claude-opus-5', paused: true })).toBe(armKeyOf(base))
  })
})

describe('실행 기록', () => {
  it('이력은 최근 10회만 남는다', () => {
    let history = emptyRecord(0).history
    for (let i = 0; i < 15; i += 1) history = pushHistory(history, { at: i, result: 'ok' })
    expect(history).toHaveLength(SCHEDULE_HISTORY_MAX)
    expect(history[0].at).toBe(5)
    expect(history[SCHEDULE_HISTORY_MAX - 1].at).toBe(14)
  })

  it('요약은 첫 줄만 뽑고 길면 자른다', () => {
    expect(summarize('# 제목\n\n- 미이행 3건 처리 완료\n나머지')).toBe('미이행 3건 처리 완료')
    expect(summarize('')).toBe('')
    expect(summarize('가'.repeat(400))).toHaveLength(201) // 200자 + 말줄임표
  })
})

describe('옛 플레이북과의 호환', () => {
  it('schedule 칸이 없어도 그대로 읽힌다', () => {
    const parsed = playbookSchema.safeParse({
      id: 'p1',
      name: '옛 플레이북',
      triggers: ['미이행'],
      instructions: '절차',
      enabled: true,
      updatedAt: 1
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.schedule).toBeUndefined()
    expect(scheduleOf(undefined)).toEqual(DEFAULT_SCHEDULE)
  })

  it('예약 칸이 깨져 있으면 예약만 버리고 플레이북은 살린다', () => {
    const parsed = playbookSchema.safeParse({
      id: 'p1',
      name: '플레이북',
      triggers: [],
      instructions: '',
      enabled: true,
      schedule: { kind: '없는종류', at: '25:00' },
      updatedAt: 1
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.schedule).toBeUndefined()
  })

  it('제대로 된 예약은 그대로 실린다', () => {
    const parsed = playbookSchema.safeParse({
      id: 'p1',
      name: '플레이북',
      triggers: [],
      instructions: '',
      enabled: true,
      schedule: { enabled: true, kind: 'daily', at: '09:00', paused: false },
      updatedAt: 1
    })
    expect(parsed.success && parsed.data.schedule?.at).toBe('09:00')
  })

  it('권한 모드 후보는 설정의 것과 같다', () => {
    expect([...SCHEDULE_PERMISSION_MODES]).toEqual([...PERMISSION_MODES])
  })
})

describe('동기화 대상', () => {
  it('실행 기록은 동기화하지 않는다', () => {
    // 기록은 기기 로컬 파일(userData/schedule-runs.json)에만 있다
    const keys = SYNCED_SETTING_KEYS as readonly string[]
    for (const forbidden of ['scheduleRuns', 'schedule-runs', 'scheduleHistory', 'lastRunAt']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('예약 설정은 플레이북에 실려 함께 동기화된다', () => {
    expect(SYNCED_SETTING_KEYS as readonly string[]).toContain('playbooks')
  })
})

// 중첩 객체를 'a.b.c' 형태의 평탄한 키 목록으로 편다
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

describe('예약 화면 표시', () => {
  it('상대 시간은 방향과 단위를 가려 준다', () => {
    const now = at(2026, 3, 10, 12, 0)
    expect(relativeTime(now + 30_000, now).key).toBe('schedule.rel.now')
    expect(relativeTime(now + 10 * 60_000, now)).toEqual({
      key: 'schedule.rel.inMinutes',
      params: { minutes: 10 }
    })
    expect(relativeTime(now - 2 * 3_600_000, now)).toEqual({
      key: 'schedule.rel.hoursAgo',
      params: { hours: 2 }
    })
    expect(relativeTime(now + 3 * 86_400_000, now)).toEqual({
      key: 'schedule.rel.inDays',
      params: { days: 3 }
    })
  })

  it('규칙 문구는 종류에 맞는 키를 고른다', () => {
    expect(rulePhrase(interval(180), []).key).toBe('schedule.rule.everyHours')
    expect(rulePhrase(interval(15), []).key).toBe('schedule.rule.everyMinutes')
    expect(rulePhrase(daily('09:00'), [])).toEqual({
      key: 'schedule.rule.daily',
      params: { at: '09:00' }
    })
    expect(rulePhrase(weekly('09:00', [1, 3]), ['월', '수']).params).toEqual({
      days: '월·수',
      at: '09:00'
    })
  })

  it('성공은 채운 점, 실패·중단은 빈 점으로 그린다', () => {
    const marks = historyMarks([
      { at: 1, result: 'ok' },
      { at: 2, result: 'failed' },
      { at: 3, result: 'skipped' }
    ])
    expect(marks.map((m) => m.glyph)).toEqual(['●', '○', '○'])
  })

  it('종류를 수동으로 되돌리면 예약이 꺼진다', () => {
    const next = withKind({ ...daily('09:00'), paused: true, pauseReason: 'failed' }, 'manual')
    expect(next.enabled).toBe(false)
    expect(next.paused).toBe(false)
    expect(next.pauseReason).toBeUndefined()
  })

  it('예약 문구는 한국어·영어에 모두 있다', () => {
    const koKeys = flatten(ko as Record<string, unknown>)
    const enKeys = flatten(en as Record<string, unknown>)
    const keys = [
      'schedule.title',
      'schedule.next',
      'schedule.last',
      'schedule.inherit',
      'schedule.inheritDesc',
      'schedule.action.runNow',
      'schedule.action.pause',
      'schedule.action.resume',
      'schedule.action.toggle',
      'schedule.field.kind',
      'schedule.field.interval',
      'schedule.field.at',
      'schedule.field.weekdays',
      'schedule.field.model',
      'schedule.field.permission',
      'schedule.rel.now',
      'schedule.rel.inMinutes',
      'schedule.rel.minutesAgo',
      'schedule.rel.inHours',
      'schedule.rel.hoursAgo',
      'schedule.rel.inDays',
      'schedule.rel.daysAgo',
      'schedule.rule.manual',
      'schedule.rule.everyHours',
      'schedule.rule.everyMinutes',
      'schedule.rule.daily',
      'schedule.rule.weekly',
      ...(['manual', 'interval', 'daily', 'weekly'] as const).map(kindLabelKey),
      ...(['off', 'paused', 'waiting', 'running'] as const).map(stateLabelKey),
      ...(['manual', 'failed', 'ai-disconnected'] as const).map(pauseReasonKey),
      ...(['ok', 'failed', 'skipped'] as const).map(resultLabelKey),
      ...[0, 1, 2, 3, 4, 5, 6].map(weekdayLabelKey),
      ...SCHEDULE_PERMISSION_MODES.map((m) => `schedule.permission.${m}`)
    ]
    for (const key of keys) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })

  it('예약 문구의 키 구성이 두 파일에서 같다', () => {
    const pick = (keys: string[]): string[] => keys.filter((k) => k.startsWith('schedule.'))
    expect(pick(flatten(ko as Record<string, unknown>))).toEqual(
      pick(flatten(en as Record<string, unknown>))
    )
  })
})
