// 사이트 기억 서비스 — 저장소와 러너를 잇는 자리.
//
//  1) 실행 시작: 이번에 볼 호스트를 뽑아 기억 블록을 만들어 준다(주입)
//  2) 실행 성공: 도구 호출 기록에서 호스트별 행동 경로·자동 메모를 뽑아 저장한다(학습)
//  3) remember_site: AI 가 배운 점을 직접 한 줄 남긴다(마스킹 뒤 저장)
//
// 순수 판정은 전부 shared/site-memory.ts 에 있다. 여기는 저장소를 읽고 쓰는 배선뿐이다.

import {
  addNote,
  addRecipe,
  autoNotesByHost,
  buildSiteMemoryBlock,
  extractStepsByHost,
  normalizeMemoryHost,
  runHosts,
  toGoal,
  toNote,
  type AgentToolCall,
  type SiteMemoryEntry,
  type SiteMemorySummary,
  type SiteRecipe
} from '../../shared/site-memory'
import { emptyEntry, type SiteMemoryStoreLike } from './site-memory-store'

export type { AgentToolCall }

/** remember_site 가 돌려주는 문자열(모델이 읽는다) */
export const REMEMBER_OK = 'ok: remembered'
export const REMEMBER_HOST_UNKNOWN = 'refused: host unknown'
export const REMEMBER_EMPTY_NOTE = 'refused: empty note'
export const REMEMBER_DISABLED = 'refused: site memory is off'

/** 이번 실행에 붙일 기억 블록과, 그 블록이 어떤 호스트에서 왔는지 */
export interface SiteMemoryBlock {
  text: string
  hosts: string[]
  /** 경로(recipe)를 실어 보냈는가 — 실행 끝에 속도 비교용 표식으로 쓴다 */
  usedRecipe: boolean
}

export class SiteMemoryService {
  constructor(
    private readonly store: SiteMemoryStoreLike,
    /** 설정의 siteMemoryEnabled. 매번 새로 읽어 끄면 곧바로 멈춘다 */
    private readonly enabled: () => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * 실행 시작 시 시스템 프롬프트 뒤에 붙일 블록을 만든다.
   * 기억이 꺼져 있거나 아는 호스트가 없으면 빈 블록
   */
  blockFor(input: {
    prompt: string
    playbookTexts?: readonly string[]
    currentUrl?: string
  }): SiteMemoryBlock {
    if (!this.enabled()) return { text: '', hosts: [], usedRecipe: false }
    const file = this.store.read()
    const hosts = runHosts(input).filter((h) => file[h] !== undefined)
    if (hosts.length === 0) return { text: '', hosts: [], usedRecipe: false }
    const entries = hosts.map((host) => ({ host, entry: file[host] }))
    const text = buildSiteMemoryBlock(entries)
    if (!text) return { text: '', hosts: [], usedRecipe: false }
    const usedRecipe = entries.some((e) => e.entry.recipes.length > 0)
    // 실어 보낸 경로의 사용 횟수를 올린다(효과 비교용)
    if (usedRecipe) {
      const next = { ...file }
      for (const { host, entry } of entries) {
        next[host] = { ...entry, recipes: entry.recipes.map((r) => ({ ...r, uses: r.uses + 1 })) }
      }
      this.store.write(next)
    }
    return { text, hosts, usedRecipe }
  }

  /**
   * 성공(done)으로 끝난 실행의 도구 호출 기록을 기억으로 접는다.
   * 저장 실패가 실행을 깨뜨리지는 않는다
   */
  learn(input: { prompt: string; calls: readonly AgentToolCall[] }): string[] {
    if (!this.enabled()) return []
    const calls = [...input.calls]
    const stepsByHost = extractStepsByHost(calls)
    const notesByHost = autoNotesByHost(calls)
    const hosts = new Set([...stepsByHost.keys(), ...notesByHost.keys()])
    if (hosts.size === 0) return []
    const goal = toGoal(input.prompt)
    const at = this.now()
    const file = { ...this.store.read() }
    for (const host of hosts) {
      const entry: SiteMemoryEntry = file[host] ?? emptyEntry()
      let recipes = entry.recipes
      const steps = stepsByHost.get(host) ?? []
      if (steps.length > 0) {
        const recipe: SiteRecipe = { goal, steps, createdAt: at, uses: 0, lastOkAt: at }
        recipes = addRecipe(recipes, recipe)
      }
      let notes = entry.notes
      for (const note of notesByHost.get(host) ?? []) notes = addNote(notes, note)
      file[host] = { recipes, notes }
    }
    this.store.write(file)
    return [...hosts]
  }

  /** remember_site 도구 — AI 가 배운 점을 직접 저장한다 */
  remember(host: string, note: string): string {
    if (!this.enabled()) return REMEMBER_DISABLED
    const key = normalizeMemoryHost(host)
    if (!key) return REMEMBER_HOST_UNKNOWN
    const cleaned = toNote(note)
    if (!cleaned) return REMEMBER_EMPTY_NOTE
    const file = { ...this.store.read() }
    const entry = file[key] ?? emptyEntry()
    file[key] = { recipes: entry.recipes, notes: addNote(entry.notes, cleaned) }
    this.store.write(file)
    return `${REMEMBER_OK} (${key})`
  }

  /** 설정 화면이 보는 호스트별 개수 목록(기억 본문은 나가지 않는다) */
  summary(): SiteMemorySummary[] {
    const file = this.store.read()
    return Object.entries(file)
      .map(([host, entry]) => ({
        host,
        recipes: entry.recipes.length,
        notes: entry.notes.length
      }))
      .sort((a, b) => a.host.localeCompare(b.host))
  }

  /** 설정 화면의 [지우기] — 도구로는 부르지 못한다 */
  forget(host: string): boolean {
    const key = normalizeMemoryHost(host)
    if (!key) return false
    const file = this.store.read()
    if (file[key] === undefined) return false
    const next = { ...file }
    delete next[key]
    this.store.write(next)
    return true
  }
}
