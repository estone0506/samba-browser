// 활동 기록의 순수 부분 — 마스킹·파일 회전·정규화·후보 산출·숨김 만료.
// 시각은 전부 로컬 Date 로 만든다(분석기도 로컬 시각으로 판단한다)

import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_PROMPT_MAX,
  activityFileName,
  expiredActivityFiles,
  isActivityFileName,
  parseActivityLine,
  parseActivityLines,
  sanitizePrompt,
  serializeActivityRecord,
  toMinutes,
  type ActivityRunRecord,
  type ActivityVisitRecord
} from '@shared/activity'
import {
  RECOMMEND_MIN_COUNT,
  activeCandidates,
  buildCandidates,
  candidateKey,
  hostWeeklyVisits,
  isDismissed,
  minutesToHhmm,
  normalizeInstruction,
  pruneDismissed
} from '@shared/activity-patterns'

const DAY = 86_400_000

/** 로컬 시각으로 한 점을 만든다 */
function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

function run(ts: number, prompt: string, playbook?: string): ActivityRunRecord {
  return { t: 'run', at: ts, prompt, ok: true, ms: 1000, ...(playbook ? { playbook } : {}) }
}

describe('지시문 마스킹·절단', () => {
  it('비밀번호처럼 보이는 조각을 지운다', () => {
    expect(sanitizePrompt('사이트 비밀번호 abcd1234 로 로그인해 줘')).toContain('비밀번호 ***')
    expect(sanitizePrompt('사이트 비밀번호 abcd1234 로 로그인해 줘')).not.toContain('abcd1234')
  })

  it('이어진 긴 숫자(인증번호·카드번호)를 지운다', () => {
    expect(sanitizePrompt('카드 4111111111111111 으로 결제')).not.toContain('4111')
  })

  it('자르기는 마스킹 뒤에 한다', () => {
    const long = `${'가'.repeat(ACTIVITY_PROMPT_MAX)} password hunter2xyz`
    const out = sanitizePrompt(long)
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_PROMPT_MAX)
    expect(out).not.toContain('hunter2xyz')
  })

  it('줄바꿈·연속 공백을 한 칸으로 줄인다', () => {
    expect(sanitizePrompt(' 주문\n\n 처리 ')).toBe('주문 처리')
  })
})

describe('월별 파일 회전(90일)', () => {
  it('파일 이름은 로컬 기준 YYYY-MM.jsonl', () => {
    expect(activityFileName(at(2026, 9, 19, 10))).toBe('2026-09.jsonl')
    expect(isActivityFileName('2026-09.jsonl')).toBe(true)
    expect(isActivityFileName('2026-13.jsonl')).toBe(false)
    expect(isActivityFileName('그밖의파일.json')).toBe(false)
  })

  it('90일이 지난 달만 지운다', () => {
    const now = at(2026, 9, 19, 10)
    const names = ['2026-09.jsonl', '2026-08.jsonl', '2026-06.jsonl', '2026-05.jsonl', 'x.txt']
    const expired = expiredActivityFiles(names, now)
    expect(expired).toContain('2026-05.jsonl')
    expect(expired).not.toContain('2026-09.jsonl')
    expect(expired).not.toContain('2026-08.jsonl')
    expect(expired).not.toContain('x.txt')
  })

  it('달의 마지막 순간까지 90일을 보장한다', () => {
    // 6월의 끝(7/1 0시)에서 정확히 90일이 지난 순간
    const boundary = new Date(2026, 6, 1).getTime() + 90 * DAY
    expect(expiredActivityFiles(['2026-06.jsonl'], boundary - 1)).toEqual([])
    expect(expiredActivityFiles(['2026-06.jsonl'], boundary)).toEqual(['2026-06.jsonl'])
  })
})

describe('JSONL 한 줄', () => {
  it('왕복한다', () => {
    const record = run(at(2026, 9, 19, 9), '미이행 주문 처리')
    expect(parseActivityLine(serializeActivityRecord(record))).toEqual(record)
  })

  it('깨진 줄은 그 줄만 버린다', () => {
    const good = serializeActivityRecord(run(at(2026, 9, 19, 9), 'a'))
    expect(parseActivityLines(`{깨짐\n${good}\n\n{"t":"run"}`)).toHaveLength(1)
  })

  it('분 단위 반올림', () => {
    expect(toMinutes(89_000)).toBe(1)
    expect(toMinutes(-5)).toBe(0)
  })
})

describe('지시문 정규화', () => {
  it('소문자·공백·숫자를 정리한다', () => {
    expect(normalizeInstruction('SAMBA  미이행 주문 3건')).toBe('samba 미이행 주문 #건')
    expect(normalizeInstruction('samba 미이행 주문 12건')).toBe('samba 미이행 주문 #건')
  })

  it('플레이북이 있으면 플레이북 이름이 묶음 기준이다', () => {
    const a = candidateKey({ prompt: '미이행 3건만', playbook: 'SAMBA 미이행 주문 처리' })
    const b = candidateKey({ prompt: '전부 처리해 줘', playbook: 'SAMBA 미이행 주문 처리' })
    expect(a).toBe(b)
    expect(a.startsWith('playbook:')).toBe(true)
  })
})

describe('추천 후보 산출', () => {
  const now = at(2026, 9, 19, 18)

  it('3회 미만은 후보가 아니다', () => {
    const runs = [run(at(2026, 9, 17, 9), '주문 처리'), run(at(2026, 9, 18, 9), '주문 처리')]
    expect(buildCandidates(runs, now)).toEqual([])
    expect(RECOMMEND_MIN_COUNT).toBe(3)
  })

  it('시각이 몰려 있으면 daily 와 대표 시각을 낸다', () => {
    const runs = [
      run(at(2026, 9, 15, 8, 55), '주문 처리'),
      run(at(2026, 9, 16, 9, 10), '주문 처리'),
      run(at(2026, 9, 17, 9, 5), '주문 처리')
    ]
    const [c] = buildCandidates(runs, now)
    expect(c.kind).toBe('daily')
    expect(c.at).toBe('09:05')
    expect(c.count).toBe(3)
    expect(c.lastAt).toBe(at(2026, 9, 17, 9, 5))
  })

  it('요일까지 같으면 weekly', () => {
    // 2026-09-02·09·16 은 모두 수요일
    const runs = [
      run(at(2026, 9, 2, 10), '주간 보고'),
      run(at(2026, 9, 9, 10, 20), '주간 보고'),
      run(at(2026, 9, 16, 9, 50), '주간 보고')
    ]
    const [c] = buildCandidates(runs, now)
    expect(c.kind).toBe('weekly')
    expect(c.weekday).toBe(new Date(at(2026, 9, 2, 10)).getDay())
    expect(c.at).not.toBeUndefined()
  })

  it('시각이 흩어져 있으면 예약 없이 자주 하는 일로만 남는다', () => {
    const runs = [
      run(at(2026, 9, 15, 3), '검색'),
      run(at(2026, 9, 16, 12), '검색'),
      run(at(2026, 9, 17, 20), '검색')
    ]
    const [c] = buildCandidates(runs, now)
    expect(c.kind).toBe('frequent')
    expect(c.at).toBeUndefined()
  })

  it('30일 밖의 기록은 세지 않는다', () => {
    const runs = [
      run(now - 40 * DAY, '옛날 일'),
      run(now - 39 * DAY, '옛날 일'),
      run(now - 38 * DAY, '옛날 일')
    ]
    expect(buildCandidates(runs, now)).toEqual([])
  })

  it('플레이북 이름을 라벨로 쓴다', () => {
    const runs = [1, 2, 3].map((d) =>
      run(at(2026, 9, 10 + d, 9), '미이행 주문', 'SAMBA 미이행 주문 처리')
    )
    const [c] = buildCandidates(runs, now)
    expect(c.label).toBe('SAMBA 미이행 주문 처리')
    expect(c.playbook).toBe('SAMBA 미이행 주문 처리')
  })

  it('자정을 건너뛰는 시각도 같은 시간대로 본다', () => {
    const runs = [
      run(at(2026, 9, 15, 23, 50), '야간 점검'),
      run(at(2026, 9, 17, 0, 10), '야간 점검'),
      run(at(2026, 9, 18, 0, 0), '야간 점검')
    ]
    const [c] = buildCandidates(runs, now)
    expect(c.kind).toBe('daily')
    expect(c.at).toBe('00:00')
  })

  it('분 → HH:MM 은 5분 단위로 맞춘다', () => {
    expect(minutesToHhmm(9 * 60 + 3)).toBe('09:05')
    expect(minutesToHhmm(-10)).toBe('23:50')
  })
})

describe('숨김', () => {
  const now = at(2026, 9, 19, 18)

  it('30일 안이면 숨겨지고 지나면 다시 나타난다', () => {
    expect(isDismissed('k', [{ key: 'k', at: now - 10 * DAY }], now)).toBe(true)
    expect(isDismissed('k', [{ key: 'k', at: now - 31 * DAY }], now)).toBe(false)
  })

  it('만료된 숨김은 걷어낸다', () => {
    const kept = pruneDismissed(
      [
        { key: 'a', at: now - 31 * DAY },
        { key: 'b', at: now - 1 * DAY }
      ],
      now
    )
    expect(kept.map((d) => d.key)).toEqual(['b'])
  })

  it('숨긴 후보는 목록에서 빠진다', () => {
    const runs = [1, 2, 3].map((d) => run(at(2026, 9, 10 + d, 9), '주문 처리'))
    const [c] = buildCandidates(runs, now)
    expect(activeCandidates(runs, [{ key: c.key, at: now }], now)).toEqual([])
    expect(activeCandidates(runs, [{ key: c.key, at: now - 31 * DAY }], now)).toHaveLength(1)
  })
})

describe('사이트 방문 집계(추천에는 쓰지 않는다)', () => {
  const now = at(2026, 9, 19, 18)
  const visit = (ts: number, host: string, minutes: number): ActivityVisitRecord => ({
    t: 'visit',
    at: ts,
    host,
    minutes
  })

  it('호스트별 주간 방문 수와 머문 시간을 모은다', () => {
    const rows = hostWeeklyVisits(
      [
        visit(now - 1 * DAY, 'musinsa.com', 3),
        visit(now - 2 * DAY, 'musinsa.com', 5),
        visit(now - 9 * DAY, 'musinsa.com', 2),
        visit(now - 1 * DAY, 'naver.com', 1)
      ],
      now
    )
    const thisWeek = rows.find((r) => r.host === 'musinsa.com' && r.weeksAgo === 0)
    expect(thisWeek).toEqual({ host: 'musinsa.com', weeksAgo: 0, visits: 2, minutes: 8 })
    expect(rows.find((r) => r.host === 'musinsa.com' && r.weeksAgo === 1)?.visits).toBe(1)
    expect(rows.find((r) => r.host === 'naver.com')?.visits).toBe(1)
  })
})
