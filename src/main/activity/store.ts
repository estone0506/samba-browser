// 활동 기록 저장소 — 기기 로컬 파일(userData/activity/YYYY-MM.jsonl).
//
// 왜 설정도 DB 도 아닌 월별 JSONL 인가
//  - "이 PC 에서 무엇을 자주 하나" 는 그 PC 의 사실이다. 동기화 경로에 얹으면
//    다른 PC 의 습관과 섞여 추천이 엉뚱해지고, 기록이 서버로 나갈 이유도 없다.
//  - 덧붙이기만 하는 성격이라 한 줄씩 append 하면 되고, 만료는 달 파일 하나를
//    지우는 것으로 끝난다(90일).
//  - 한 줄이 깨져도 그 줄만 버린다 — 파일 전체를 잃지 않는다.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  activityFileName,
  expiredActivityFiles,
  isActivityFileName,
  parseActivityLines,
  serializeActivityRecord,
  type ActivityRecord,
  type ActivityRunRecord,
  type ActivityVisitRecord
} from '../../shared/activity'

export class ActivityStore {
  /** 마지막으로 만료 청소를 한 달 파일 이름. 달이 바뀔 때마다 한 번만 돈다 */
  private lastPrunedFile = ''

  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 기록 한 줄을 덧붙인다. 실패해도 예외를 던지지 않는다(기록은 부수적인 일이다) */
  append(record: ActivityRecord): void {
    if (!this.dir) return
    const name = activityFileName(record.at)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, name), serializeActivityRecord(record), 'utf8')
    } catch (e) {
      // 값은 로그에 남기지 않는다(지시문이 들어 있다)
      console.warn('활동 기록 저장 실패', e instanceof Error ? e.message : '')
      return
    }
    if (this.lastPrunedFile !== name) {
      this.lastPrunedFile = name
      this.prune()
    }
  }

  /** 90일이 지난 달 파일을 지운다 */
  prune(): void {
    if (!this.dir || !existsSync(this.dir)) return
    try {
      const names = readdirSync(this.dir).filter(isActivityFileName)
      for (const name of expiredActivityFiles(names, this.now())) {
        rmSync(join(this.dir, name), { force: true })
      }
    } catch (e) {
      console.warn('활동 기록 청소 실패', e instanceof Error ? e.message : '')
    }
  }

  /** 그 시각 이후의 기록 전부(오래된 것부터). 읽으면서 만료 파일도 건너뛴다 */
  readSince(from: number): ActivityRecord[] {
    if (!this.dir || !existsSync(this.dir)) return []
    let names: string[]
    try {
      names = readdirSync(this.dir).filter(isActivityFileName).sort()
    } catch (e) {
      console.warn('활동 기록 목록 읽기 실패', e instanceof Error ? e.message : '')
      return []
    }
    const out: ActivityRecord[] = []
    for (const name of names) {
      try {
        for (const record of parseActivityLines(readFileSync(join(this.dir, name), 'utf8'))) {
          if (record.at >= from) out.push(record)
        }
      } catch (e) {
        console.warn('활동 기록 읽기 실패', e instanceof Error ? e.message : '')
      }
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** 지시 기록만 */
  runsSince(from: number): ActivityRunRecord[] {
    return this.readSince(from).filter((r): r is ActivityRunRecord => r.t === 'run')
  }

  /** 사이트 방문 기록만 */
  visitsSince(from: number): ActivityVisitRecord[] {
    return this.readSince(from).filter((r): r is ActivityVisitRecord => r.t === 'visit')
  }

  /** "지금까지 기록 지우기" — 폴더 안의 기록 파일을 전부 지운다 */
  clear(): boolean {
    if (!this.dir || !existsSync(this.dir)) return true
    try {
      for (const name of readdirSync(this.dir).filter(isActivityFileName)) {
        rmSync(join(this.dir, name), { force: true })
      }
      this.lastPrunedFile = ''
      return true
    } catch (e) {
      console.warn('활동 기록 삭제 실패', e instanceof Error ? e.message : '')
      return false
    }
  }
}
