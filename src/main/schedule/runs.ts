// 예약 실행 기록 저장소 — 기기 로컬 파일(userData/schedule-runs.json).
//
// 왜 설정이 아니라 파일인가
//  - "이 PC 에서 언제 돌았나" 는 PC 마다 다른 사실이다. 설정에 넣으면 동기화를 타고
//    다른 PC 의 실행 시각을 덮어써 따라잡기 판정이 뒤틀린다.
//  - 값은 실행 시각·결과·한 줄 요약뿐이다. 요약은 AI 응답의 첫 줄이라 평문이지만
//    비밀값은 담기지 않는다(비밀값은 언제나 키마스터가 쥔다).
//
// 파일이 깨져 있으면 통째로 버리고 빈 상태로 시작한다 — 기록은 복구할 가치보다
// 잘못된 시각으로 예약이 엉키는 위험이 크다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  emptyRecord,
  scheduleRunsFileSchema,
  type ScheduleRunRecord
} from '../../shared/schedule'

export class ScheduleRunStore {
  private records = new Map<string, ScheduleRunRecord>()

  constructor(
    private readonly filePath: string | null,
    private readonly now: () => number = () => Date.now()
  ) {
    this.load()
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const parsed = scheduleRunsFileSchema.safeParse(
        JSON.parse(readFileSync(this.filePath, 'utf8'))
      )
      if (!parsed.success) return
      for (const [id, record] of Object.entries(parsed.data.records)) {
        this.records.set(id, record)
      }
    } catch (e) {
      // 값은 로그에 남기지 않는다(요약에 사용자가 시킨 일의 내용이 들어 있다)
      console.warn('예약 실행 기록 읽기 실패, 빈 상태로 시작', e instanceof Error ? e.message : '')
      this.records.clear()
    }
  }

  private flush(): void {
    if (!this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(
        this.filePath,
        JSON.stringify({ version: 1, records: Object.fromEntries(this.records) }),
        'utf8'
      )
    } catch (e) {
      console.warn('예약 실행 기록 저장 실패', e instanceof Error ? e.message : '')
    }
  }

  /** 없으면 빈 기록을 만들어 돌려준다(저장까지 하지는 않는다) */
  get(playbookId: string): ScheduleRunRecord {
    return this.records.get(playbookId) ?? emptyRecord(this.now())
  }

  /** 기록 한 건을 바꿔 쓴다 */
  set(playbookId: string, record: ScheduleRunRecord): ScheduleRunRecord {
    this.records.set(playbookId, record)
    this.flush()
    return record
  }

  /** 기존 기록 위에 일부만 덮어쓴다 */
  patch(playbookId: string, patch: Partial<ScheduleRunRecord>): ScheduleRunRecord {
    return this.set(playbookId, { ...this.get(playbookId), ...patch })
  }

  /** 지워진 플레이북의 기록을 걷어낸다(파일이 한없이 자라지 않게) */
  keepOnly(playbookIds: readonly string[]): void {
    const alive = new Set(playbookIds)
    let changed = false
    for (const id of [...this.records.keys()]) {
      if (alive.has(id)) continue
      this.records.delete(id)
      changed = true
    }
    if (changed) this.flush()
  }
}
