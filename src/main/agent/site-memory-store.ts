// 사이트 기억 저장소 — 기기 로컬 파일(userData/site-memory.json).
//
// 왜 설정이 아니라 파일인가
//  - "이 PC 에서 이 사이트가 어떻게 움직였나" 는 그 PC 의 관찰 결과다. 설정 동기화 경로에
//    얹으면 다른 PC 의 관찰과 섞이고, 서버로 나갈 이유도 없다(SYNCED_SETTING_KEYS 무관).
//  - 파일이 깨져 있으면 통째로 버리고 빈 기억에서 다시 시작한다 — 복구할 가치가 낮다.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  siteMemoryFileSchema,
  SITE_HOST_MAX,
  type SiteMemoryEntry,
  type SiteMemoryFile
} from '../../shared/site-memory'

/** 러너·도구가 보는 저장소 모양(테스트에서 메모리 대역으로 갈아 끼운다) */
export interface SiteMemoryStoreLike {
  read(): SiteMemoryFile
  write(file: SiteMemoryFile): void
}

/** 빈 기억 한 칸 */
export function emptyEntry(): SiteMemoryEntry {
  return { recipes: [], notes: [] }
}

export class SiteMemoryStore implements SiteMemoryStoreLike {
  // 읽을 때마다 파일을 긁지 않도록 한 벌 들고 있는다(쓰기는 즉시 파일로 내린다)
  private cache: SiteMemoryFile | null = null

  /** path 가 null 이면 아무것도 저장하지 않는다(기억 기능이 꺼진 실행·테스트) */
  constructor(private readonly path: string | null) {}

  read(): SiteMemoryFile {
    if (this.cache) return this.cache
    if (!this.path || !existsSync(this.path)) {
      this.cache = {}
      return this.cache
    }
    try {
      const parsed = siteMemoryFileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      this.cache = parsed.success ? parsed.data : {}
    } catch (e) {
      // 값은 로그에 남기지 않는다(라벨이 들어 있다)
      console.warn('사이트 기억 읽기 실패', e instanceof Error ? e.message : '')
      this.cache = {}
    }
    return this.cache
  }

  write(file: SiteMemoryFile): void {
    // 호스트 수 상한 — 넘치면 오래 전에 쓴 칸(앞쪽)부터 버린다
    const hosts = Object.keys(file)
    const kept =
      hosts.length <= SITE_HOST_MAX
        ? file
        : Object.fromEntries(hosts.slice(hosts.length - SITE_HOST_MAX).map((h) => [h, file[h]]))
    this.cache = kept
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(kept), 'utf8')
    } catch (e) {
      console.warn('사이트 기억 저장 실패', e instanceof Error ? e.message : '')
    }
  }

  /** 설정 화면의 [지우기] — 호스트 한 곳의 기억만 지운다 */
  forget(host: string): boolean {
    const file = this.read()
    if (!(host in file)) return false
    const next = { ...file }
    delete next[host]
    this.write(next)
    return true
  }

  /** 기억 파일 전체를 지운다 */
  clear(): void {
    this.cache = {}
    if (!this.path || !existsSync(this.path)) return
    try {
      rmSync(this.path, { force: true })
    } catch (e) {
      console.warn('사이트 기억 삭제 실패', e instanceof Error ? e.message : '')
    }
  }
}
