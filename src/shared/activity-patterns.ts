// 반복 패턴 분석 — 순수 함수만 둔다(AI 호출 없음, 파일 접근 없음).
//
// "같은 지시를 자꾸 되풀이하고 있다" 는 사실만으로 예약을 권한다. 규칙 기반이라
// 사용자가 근거(횟수·시각 분포·마지막 실행)를 그대로 읽고 판단할 수 있다.
//
// 사이트 방문은 추천에 쓰지 않는다. 다음 단계에서 쓸 수 있게 집계 함수만 둔다.

import { DAY_MS, type ActivityRunRecord, type ActivityVisitRecord } from './activity'

/** 후보가 되려면 이만큼은 되풀이돼야 한다 */
export const RECOMMEND_MIN_COUNT = 3
/** 분석 대상 기간(일) */
export const RECOMMEND_WINDOW_DAYS = 30
/** 이 분 안에 몰려 있으면 "같은 시간대" 로 본다 */
export const RECOMMEND_TIME_SPREAD_MIN = 90
/** 숨긴 후보가 다시 나타나기까지의 일수 */
export const RECOMMEND_DISMISS_DAYS = 30
/** 화면에 한 번에 그리는 추천 개수 */
export const RECOMMEND_MAX = 5

const MINUTES_PER_DAY = 1440

/** 추천 종류. 'frequent' 는 예약을 정하지 못해 "자주 하는 일" 로만 보여 주는 경우다 */
export type RecommendKind = 'daily' | 'weekly' | 'frequent'

/** 숨긴 후보 한 칸(기기 로컬 설정에 저장한다) */
export interface DismissedRecommendation {
  key: string
  at: number
}

/** 추천 후보 한 건. 근거를 함께 실어 사용자가 판단할 수 있게 한다 */
export interface RecommendCandidate {
  /** 숨기기·적용에 쓰는 고유 키(정규화 결과) */
  key: string
  /** 화면에 보여 줄 이름 — 플레이북이면 플레이북 이름, 아니면 지시문 */
  label: string
  /** 플레이북 이름(있을 때만). 메인이 이 이름으로 플레이북 id 를 찾는다 */
  playbook?: string
  kind: RecommendKind
  /** 'HH:MM' — daily·weekly 일 때만 */
  at?: string
  /** 0=일 ~ 6=토 — weekly 일 때만 */
  weekday?: number
  /** 근거: 되풀이 횟수 */
  count: number
  /** 근거: 처음 본 때부터 지금까지의 일수(최소 1) */
  spanDays: number
  /** 근거: 실행 시각 분포(0~23시, 오름차순 중복 포함) */
  hours: number[]
  /** 근거: 마지막 실행 시각 */
  lastAt: number
}

/**
 * 지시문 비교용 정규화.
 * 소문자 → 공백 정리 → 숫자열을 `#` 하나로 바꾼다.
 * ("미이행 주문 3건" 과 "미이행 주문 5건" 이 같은 일로 묶이게 하려는 것이다)
 */
export function normalizeInstruction(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

/** 묶음 키. 플레이북이 있으면 플레이북 이름이 기준이다 */
export function candidateKey(run: Pick<ActivityRunRecord, 'prompt' | 'playbook'>): string {
  const playbook = run.playbook?.trim() ?? ''
  if (playbook !== '') return `playbook:${normalizeInstruction(playbook)}`
  return `prompt:${normalizeInstruction(run.prompt)}`
}

/** 두 시각(자정부터의 분) 사이의 가장 짧은 거리. 23:50 과 00:10 은 20분이다 */
function circularDiff(a: number, b: number): number {
  const raw = (((a - b) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return raw > MINUTES_PER_DAY / 2 ? raw - MINUTES_PER_DAY : raw
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 분 → 'HH:MM'. 5분 단위로 반올림해 "09:00" 같은 사람 말에 가깝게 만든다 */
export function minutesToHhmm(minutes: number): string {
  const snapped = (Math.round(minutes / 5) * 5 + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const h = String(Math.floor(snapped / 60)).padStart(2, '0')
  const m = String(snapped % 60).padStart(2, '0')
  return `${h}:${m}`
}

/** 한 묶음의 시각들이 같은 시간대(±90분)에 몰려 있으면 대표 시각을 돌려준다 */
function tightTime(times: readonly number[]): string | null {
  if (times.length === 0) return null
  const anchor = median(times)
  const offsets = times.map((t) => circularDiff(t, anchor))
  if (offsets.some((o) => Math.abs(o) > RECOMMEND_TIME_SPREAD_MIN)) return null
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length
  return minutesToHhmm(anchor + mean)
}

/**
 * 최근 30일 지시 기록에서 추천 후보를 뽑는다.
 * 3회 미만은 버리고, 시각이 몰려 있으면 daily, 요일까지 같으면 weekly,
 * 둘 다 아니면 예약 없이 "자주 하는 일"(frequent)로만 남긴다
 */
export function buildCandidates(
  runs: readonly ActivityRunRecord[],
  now: number
): RecommendCandidate[] {
  const since = now - RECOMMEND_WINDOW_DAYS * DAY_MS
  const groups = new Map<string, ActivityRunRecord[]>()
  for (const run of runs) {
    if (run.at < since || run.at > now) continue
    const key = candidateKey(run)
    const bucket = groups.get(key)
    if (bucket) bucket.push(run)
    else groups.set(key, [run])
  }

  const out: RecommendCandidate[] = []
  for (const [key, bucket] of groups) {
    if (bucket.length < RECOMMEND_MIN_COUNT) continue
    const dates = bucket.map((r) => new Date(r.at))
    const times = dates.map((d) => d.getHours() * 60 + d.getMinutes())
    const weekdays = dates.map((d) => d.getDay())
    const at = tightTime(times)
    const sameWeekday = weekdays.every((d) => d === weekdays[0])
    const firstAt = Math.min(...bucket.map((r) => r.at))
    const lastAt = Math.max(...bucket.map((r) => r.at))
    const playbook = bucket.find((r) => (r.playbook ?? '') !== '')?.playbook
    const kind: RecommendKind = at === null ? 'frequent' : sameWeekday ? 'weekly' : 'daily'
    out.push({
      key,
      label: playbook ?? bucket[bucket.length - 1].prompt,
      ...(playbook === undefined ? {} : { playbook }),
      kind,
      ...(at === null ? {} : { at }),
      ...(kind === 'weekly' ? { weekday: weekdays[0] } : {}),
      count: bucket.length,
      spanDays: Math.max(1, Math.ceil((now - firstAt) / DAY_MS)),
      hours: dates.map((d) => d.getHours()).sort((a, b) => a - b),
      lastAt
    })
  }
  // 되풀이가 잦은 것 먼저, 같으면 최근 것 먼저
  return out.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
}

/** 아직 숨김이 살아 있는가(30일이 지나면 다시 나타난다) */
export function isDismissed(
  key: string,
  dismissed: readonly DismissedRecommendation[],
  now: number
): boolean {
  const limit = now - RECOMMEND_DISMISS_DAYS * DAY_MS
  return dismissed.some((d) => d.key === key && d.at > limit)
}

/** 만료된 숨김을 걷어낸다(설정이 한없이 자라지 않게) */
export function pruneDismissed(
  dismissed: readonly DismissedRecommendation[],
  now: number
): DismissedRecommendation[] {
  const limit = now - RECOMMEND_DISMISS_DAYS * DAY_MS
  return dismissed.filter((d) => d.at > limit)
}

/** 화면에 그릴 추천 — 숨긴 것을 빼고 개수를 자른다 */
export function activeCandidates(
  runs: readonly ActivityRunRecord[],
  dismissed: readonly DismissedRecommendation[],
  now: number
): RecommendCandidate[] {
  return buildCandidates(runs, now)
    .filter((c) => !isDismissed(c.key, dismissed, now))
    .slice(0, RECOMMEND_MAX)
}

/** 호스트별 주간 방문 집계 한 줄 */
export interface HostWeekStat {
  host: string
  /** 0 = 최근 7일, 1 = 그 전 7일 … */
  weeksAgo: number
  visits: number
  /** 머문 시간 합(분) */
  minutes: number
}

/**
 * 호스트별 주간 방문 수(다음 단계용 집계).
 * 지금은 추천에 쓰지 않는다 — 사이트 방문으로는 아무것도 권하지 않는다
 */
export function hostWeeklyVisits(
  visits: readonly ActivityVisitRecord[],
  now: number,
  windowDays: number = RECOMMEND_WINDOW_DAYS
): HostWeekStat[] {
  const since = now - windowDays * DAY_MS
  const byKey = new Map<string, HostWeekStat>()
  for (const visit of visits) {
    if (visit.at < since || visit.at > now) continue
    const weeksAgo = Math.floor((now - visit.at) / (7 * DAY_MS))
    // 호스트에 들어갈 수 없는 구분자('/')로 두 값을 잇는다
    const key = `${visit.host}/${weeksAgo}`
    const found = byKey.get(key)
    if (found) {
      found.visits += 1
      found.minutes += visit.minutes
    } else {
      byKey.set(key, { host: visit.host, weeksAgo, visits: 1, minutes: visit.minutes })
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.weeksAgo - b.weeksAgo || b.visits - a.visits || a.host.localeCompare(b.host)
  )
}
