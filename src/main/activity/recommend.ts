// 추천 서비스 — 기록을 읽어 후보를 내고, 사용자가 누르면 예약으로 바꾼다.
//
// 판정은 전부 shared/activity-patterns 의 순수 함수가 한다. 여기서는 저장소를 잇고
// (기록 파일 · 설정의 숨김 목록 · 플레이북 목록) 후보에 플레이북 id 를 붙일 뿐이다.
// AI 는 부르지 않는다.

import {
  RECOMMEND_WINDOW_DAYS,
  activeCandidates,
  normalizeInstruction,
  pruneDismissed,
  type DismissedRecommendation,
  type RecommendApplyDto,
  type RecommendCandidate,
  type RecommendDto
} from '../../shared/activity-patterns'
import { DAY_MS, type ActivityRunRecord } from '../../shared/activity'
import {
  PLAYBOOK_NAME_MAX,
  PLAYBOOK_TRIGGER_MAX,
  type PlaybookDto,
  type PlaybookInput
} from '../../shared/playbook'
import type { PlaybookSchedule } from '../../shared/schedule'

interface RecommendSettingsAccess {
  get(): { activityRecording: boolean; dismissedRecommendations: DismissedRecommendation[] }
  set(patch: { dismissedRecommendations: DismissedRecommendation[] }): unknown
}

interface RecommendPlaybookAccess {
  list(): PlaybookDto[]
  put(input: PlaybookInput): PlaybookDto | null
  setSchedule(id: string, schedule: PlaybookSchedule): PlaybookDto | null
}

export interface RecommendDeps {
  runs: { runsSince(from: number): ActivityRunRecord[] }
  settings: RecommendSettingsAccess
  playbooks: RecommendPlaybookAccess
  now?: () => number
}

/** 후보가 가리키는 플레이북을 이름으로 찾는다(정규화해서 비교한다) */
function findPlaybook(
  candidate: RecommendCandidate,
  playbooks: readonly PlaybookDto[]
): PlaybookDto | undefined {
  const name = candidate.playbook
  if (name === undefined) return undefined
  const key = normalizeInstruction(name)
  return playbooks.find((p) => normalizeInstruction(p.name) === key)
}

/** 후보 → 예약 설정. 시각이 정해지지 않은 후보(frequent)는 예약을 만들지 않는다 */
export function scheduleOfCandidate(candidate: RecommendCandidate): PlaybookSchedule | null {
  if (candidate.at === undefined) return null
  if (candidate.kind === 'weekly' && candidate.weekday !== undefined) {
    return {
      enabled: true,
      kind: 'weekly',
      at: candidate.at,
      weekdays: [candidate.weekday],
      paused: false
    }
  }
  if (candidate.kind === 'daily') {
    return { enabled: true, kind: 'daily', at: candidate.at, paused: false }
  }
  return null
}

export class RecommendService {
  private readonly now: () => number

  constructor(private readonly deps: RecommendDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** 지금 보여 줄 추천 목록. 기록을 끈 상태면 언제나 빈 목록이다 */
  list(): RecommendDto[] {
    const settings = this.deps.settings.get()
    if (!settings.activityRecording) return []
    const now = this.now()
    const runs = this.deps.runs.runsSince(now - RECOMMEND_WINDOW_DAYS * DAY_MS)
    const playbooks = this.deps.playbooks.list()
    return activeCandidates(runs, settings.dismissedRecommendations, now).map((candidate) => {
      const playbook = findPlaybook(candidate, playbooks)
      return { ...candidate, ...(playbook === undefined ? {} : { playbookId: playbook.id }) }
    })
  }

  /** [숨기기]. 30일 뒤 다시 나타난다(만료된 숨김은 이참에 걷어낸다) */
  dismiss(key: string): boolean {
    if (key.trim() === '') return false
    const now = this.now()
    const kept = pruneDismissed(this.deps.settings.get().dismissedRecommendations, now).filter(
      (d) => d.key !== key
    )
    this.deps.settings.set({ dismissedRecommendations: [...kept, { key, at: now }] })
    return true
  }

  /**
   * [예약 만들기].
   * 플레이북이 이미 있으면 그 플레이북에 예약을 채워 켠다.
   * 없으면 지시문으로 새 플레이북을 만들고(예약도 함께) 편집기를 열도록 알린다
   */
  apply(key: string): RecommendApplyDto | null {
    const candidate = this.list().find((c) => c.key === key)
    if (!candidate) return null
    const schedule = scheduleOfCandidate(candidate)
    if (candidate.playbookId !== undefined) {
      if (schedule === null)
        return { playbookId: candidate.playbookId, created: false, scheduled: false }
      const updated = this.deps.playbooks.setSchedule(candidate.playbookId, schedule)
      if (!updated) return null
      return { playbookId: updated.id, created: false, scheduled: true }
    }
    // 새 플레이북. 이름·트리거는 지시문에서 뽑고, 절차는 그 지시문 한 줄로 시작한다 —
    // 사용자가 편집기에서 다듬는 것이 전제다
    const label = candidate.label.trim()
    if (label === '') return null
    const created = this.deps.playbooks.put({
      name: label.slice(0, PLAYBOOK_NAME_MAX),
      triggers: [label.slice(0, PLAYBOOK_TRIGGER_MAX)],
      instructions: label,
      enabled: true,
      ...(schedule === null ? {} : { schedule })
    })
    if (!created) return null
    return { playbookId: created.id, created: true, scheduled: schedule !== null }
  }
}
