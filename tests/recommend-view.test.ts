// 추천 카드의 표시 로직과 i18n 문구(ko/en 대칭).

import { describe, it, expect } from 'vitest'
import { actionKeyOf, sentenceOf } from '@renderer/components/automation/recommend-view'
import type { RecommendDto } from '@shared/activity-patterns'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

function candidate(patch: Partial<RecommendDto> = {}): RecommendDto {
  return {
    key: 'playbook:samba 미이행',
    label: 'SAMBA 미이행 주문 처리',
    kind: 'daily',
    at: '09:00',
    count: 9,
    spanDays: 14,
    hours: [9, 9, 9],
    lastAt: 1,
    ...patch
  }
}

describe('추천 문장', () => {
  it('매일 추천은 시각을 함께 말한다', () => {
    expect(sentenceOf(candidate())).toEqual({
      key: 'recommend.daily',
      params: { label: 'SAMBA 미이행 주문 처리', days: 14, count: 9, time: '09:00' }
    })
  })

  it('매주 추천은 요일 이름을 받아 쓴다', () => {
    const phrase = sentenceOf(candidate({ kind: 'weekly', weekday: 3 }), '수')
    expect(phrase.key).toBe('recommend.weekly')
    expect(phrase.params?.weekday).toBe('수')
  })

  it('시각이 흩어진 후보는 예약을 권하지 않는 문장을 쓴다', () => {
    const phrase = sentenceOf(candidate({ kind: 'frequent', at: undefined }))
    expect(phrase.key).toBe('recommend.frequent')
    expect(phrase.params?.time).toBeUndefined()
  })
})

describe('추천 버튼', () => {
  it('매일·매주는 예약 만들기', () => {
    expect(actionKeyOf(candidate())).toBe('recommend.action.create')
    expect(actionKeyOf(candidate({ kind: 'weekly', weekday: 3 }))).toBe('recommend.action.create')
  })

  it('자주 하는 일은 플레이북이 없을 때만 저장을 권한다', () => {
    const frequent = candidate({ kind: 'frequent', at: undefined })
    expect(actionKeyOf(frequent)).toBe('recommend.action.savePlaybook')
    expect(actionKeyOf({ ...frequent, playbookId: 'p1' })).toBeNull()
  })
})

describe('recommend i18n', () => {
  const flatten = (obj: Record<string, unknown>, prefix = ''): string[] => {
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
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('추천·활동 기록 키가 두 파일에 모두 있다', () => {
    for (const key of [
      'recommend.title',
      'recommend.desc',
      'recommend.daily',
      'recommend.weekly',
      'recommend.frequent',
      'recommend.evidence',
      'recommend.failed',
      'recommend.action.create',
      'recommend.action.savePlaybook',
      'recommend.action.dismiss',
      'settingsPage.agent.activityTitle',
      'settingsPage.agent.activity',
      'settingsPage.agent.activityDesc',
      'settingsPage.agent.activityClear',
      'settingsPage.agent.activityClearDesc',
      'settingsPage.agent.activityCleared'
    ]) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })

  it('두 파일의 recommend 키 집합이 같다', () => {
    const pick = (keys: string[]): string[] => keys.filter((k) => k.startsWith('recommend.'))
    expect(pick(koKeys)).toEqual(pick(enKeys))
  })
})
