// 번역 결과 캐시 — 세션 메모리 + 디스크 LRU(기본 1만 건).
//
// 안전 규칙
//  - 열쇠는 "대상 언어 + 원문 sha256" 이라 원문 자체는 디스크에 남지 않는다.
//    다만 값(번역문)은 평문이다 — 즉 이 파일을 읽으면 사용자가 본 문장을 알 수 있다.
//    그래서 캐시는 작업공간(프로필)마다 따로 두고(setFile), 캐시 파일을 다른
//    작업공간과 공유하지 않는다. 값 자체를 암호화하지는 않는다(금고 밖 기능이다).
//  - 기기 로컬 파일이라 동기화 대상이 아니다(설정 화면의 "캐시 지우기" 로 비운다).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { TRANSLATE_CACHE_LIMIT } from '../../shared/translate'

/** 캐시 열쇠 — 대상 언어 + 원문의 sha256. 원문은 되돌릴 수 없다 */
export function cacheKey(lang: string, text: string): string {
  return `${lang}:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`
}

interface CacheFile {
  version: 1
  entries: [string, string][]
}

export class TranslateCache {
  // Map 은 삽입 순서를 지키므로, 쓸 때마다 다시 넣어 주면 그대로 LRU 가 된다
  private entries = new Map<string, string>()
  private dirty = false

  constructor(
    private filePath: string | null = null,
    private readonly limit: number = TRANSLATE_CACHE_LIMIT
  ) {
    this.load()
  }

  /**
   * 작업공간(프로필)이 바뀌면 캐시 파일을 갈아 끼운다.
   * 번역문은 평문으로 들어 있으므로 작업공간 사이에 섞이지 않게 한다 —
   * 지금까지 쌓은 것은 먼저 내려쓰고, 메모리는 비운 뒤 새 파일을 읽는다
   */
  setFile(filePath: string | null): void {
    if (filePath === this.filePath) return
    this.flush()
    this.filePath = filePath
    this.entries.clear()
    this.dirty = false
    this.load()
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const file = raw as Partial<CacheFile>
      if (!Array.isArray(file.entries)) return
      for (const pair of file.entries) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        const [key, value] = pair
        if (typeof key !== 'string' || typeof value !== 'string') continue
        this.entries.set(key, value)
      }
      this.evict()
    } catch (e) {
      // 손상된 캐시는 그냥 비운 채로 시작한다(값은 로그에 남기지 않는다)
      console.warn('번역 캐시 읽기 실패, 빈 상태로 시작', e instanceof Error ? e.message : '')
      this.entries.clear()
    }
  }

  /** 가장 오래 안 쓴 항목부터 한도까지 줄인다 */
  private evict(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  get(lang: string, text: string): string | undefined {
    const key = cacheKey(lang, text)
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    // 최근 사용으로 올린다
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  set(lang: string, text: string, translated: string): void {
    const key = cacheKey(lang, text)
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, translated)
    this.evict()
    this.dirty = true
  }

  size(): number {
    return this.entries.size
  }

  /** 메모리와 디스크 캐시를 모두 비운다 */
  clear(): void {
    this.entries.clear()
    this.dirty = false
    if (!this.filePath) return
    try {
      if (existsSync(this.filePath)) rmSync(this.filePath, { force: true })
    } catch (e) {
      console.warn('번역 캐시 삭제 실패', e instanceof Error ? e.message : '')
    }
  }

  /** 디스크에 내려쓴다(바뀐 것이 없으면 아무 일도 하지 않는다) */
  flush(): void {
    if (!this.filePath || !this.dirty) return
    const file: CacheFile = { version: 1, entries: [...this.entries.entries()] }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(file))
      this.dirty = false
    } catch (e) {
      console.warn('번역 캐시 저장 실패', e instanceof Error ? e.message : '')
    }
  }
}
