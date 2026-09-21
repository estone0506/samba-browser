// 사이트 스크립트 저장소 — 기기 로컬 파일(userData/site-scripts.json).
// 사이트 기억과 같은 이유로 설정 동기화에 얹지 않는다(이 PC 에서 통한 손놀림이다).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  recordScriptRun,
  siteScriptFileSchema,
  upsertScript,
  validateScriptInput,
  type SiteScript,
  type SiteScriptInput
} from '../../shared/site-scripts'

export class SiteScriptStore {
  private cache: SiteScript[] | null = null

  /** path 가 null 이면 메모리에만 둔다(테스트) */
  constructor(
    private readonly path: string | null,
    private readonly now: () => number = Date.now
  ) {}

  list(): SiteScript[] {
    if (this.cache) return this.cache
    if (!this.path || !existsSync(this.path)) {
      this.cache = []
      return this.cache
    }
    try {
      this.cache = siteScriptFileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (e) {
      console.warn('사이트 스크립트 읽기 실패', e instanceof Error ? e.message : '')
      this.cache = []
    }
    return this.cache
  }

  find(name: string): SiteScript | undefined {
    return this.list().find((s) => s.name === name)
  }

  /** 저장한다. 거절이면 모델에게 돌려줄 문구, 성공이면 'saved: …' */
  save(input: SiteScriptInput): string {
    const problem = validateScriptInput(input)
    if (problem) return problem
    const replaced = this.find(input.name) !== undefined
    this.write(upsertScript(this.list(), input, this.now()))
    return `${replaced ? 'updated' : 'saved'}: ${input.name}`
  }

  /** 실행 결과를 통계에 남긴다 */
  ran(name: string, ok: boolean): void {
    this.write(recordScriptRun(this.list(), name, ok, this.now()))
  }

  remove(name: string): boolean {
    const next = this.list().filter((s) => s.name !== name)
    if (next.length === this.list().length) return false
    this.write(next)
    return true
  }

  private write(list: SiteScript[]): void {
    this.cache = list
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(list, null, 2), 'utf8')
    } catch (e) {
      console.warn('사이트 스크립트 저장 실패', e instanceof Error ? e.message : '')
    }
  }
}
