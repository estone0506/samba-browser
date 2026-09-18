// 파비콘 서비스 — 사이트 자체에서만 파비콘을 받아 디스크에 캐시한다.
//
// 예전에는 구글(t0.gstatic.com/faviconV2)로 호스트를 보내 파비콘을 받았다. 그러면
// 키마스터에 저장된 계정 도메인 전체가 제3자에게 그대로 넘어간다(프라이버시 문제).
// 여기서는 대상 사이트 자신에게만 요청하므로 사용자가 어차피 방문하는 곳 외에는
// 아무 데도 도메인이 나가지 않는다.
//
// electron 을 import 하지 않는다(fetch·캐시 경로는 주입받는다). 덕분에 테스트에서
// 그대로 호출할 수 있고, IPC 배선은 ipc/favicon.ts 가 담당한다.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeHost } from '../../shared/host'

/** 성공 캐시 수명(7일) */
export const FAVICON_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 실패(null) 캐시 수명(1일) — 없는 사이트에 매번 다시 묻지 않기 위해서 */
export const FAVICON_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000
/** 내려받기 상한(64KB). 파비콘이 이보다 크면 파비콘이 아니라고 본다 */
export const FAVICON_MAX_BYTES = 64 * 1024
/** 요청 타임아웃(4초) */
export const FAVICON_TIMEOUT_MS = 4000

// net.fetch / session.fetch 의 응답 중 실제로 쓰는 부분만 좁힌 형태.
// DOM 의 Response 가 구조적으로 이 모양을 만족하므로 그대로 넘길 수 있다
export interface FaviconResponse {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
}

export type FaviconFetch = (
  url: string,
  init: { signal: AbortSignal; redirect?: 'follow' }
) => Promise<FaviconResponse>

export interface FaviconServiceDeps {
  /** 캐시 디렉터리(예: %APPDATA%/SAMBA Browser/favicons) */
  cacheDir: string
  fetch: FaviconFetch
  /** 테스트에서 시간 흐름을 제어하기 위한 주입점 */
  now?: () => number
}

interface CacheEntry {
  // null 이면 "가져오기 실패"를 캐시한 것이다
  dataUrl: string | null
  at: number
}

// 파일명으로 쓸 수 있는 안전한 호스트인지 검사한다.
// 라벨은 영숫자로 시작/끝나고 가운데에만 하이픈이 올 수 있으므로,
// 여기를 통과한 값에는 '/', '\', '..', ':' 이 들어갈 수 없다(경로 이탈 방지)
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/** 정규화 + 유효성 검사를 통과한 호스트. 쓸 수 없는 값이면 빈 문자열 */
export function safeFaviconHost(urlOrHost: string): string {
  const host = normalizeHost(urlOrHost)
  if (!host || host.length > 253) return ''
  if (!HOST_RE.test(host)) return ''
  // 점만 있거나 TLD 하나뿐인 값(localhost 제외)은 파비콘 대상이 아니다
  if (!host.includes('.') && host !== 'localhost') return ''
  return host
}

// Content-Type 헤더에서 image/* 만 통과시킨다
function imageMime(headers: { get: (name: string) => string | null }): string {
  const raw = headers.get('content-type') ?? ''
  const mime = raw.split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) return ''
  return mime
}

export class FaviconService {
  private readonly cacheDir: string
  private readonly fetchFn: FaviconFetch
  private readonly now: () => number
  // 메모리 캐시. peek() 는 여기만 본다(동기 호출자용)
  private readonly memory = new Map<string, CacheEntry>()
  // 같은 호스트에 대한 동시 요청 합치기
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(deps: FaviconServiceDeps) {
    this.cacheDir = deps.cacheDir
    this.fetchFn = deps.fetch
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** 메모리 캐시만 동기로 조회한다(없으면 null). 동기 호출부(새 탭 북마크)용 */
  peek(urlOrHost: string): string | null {
    const host = safeFaviconHost(urlOrHost)
    if (!host) return null
    const hit = this.memory.get(host)
    if (!hit || this.expired(hit)) return null
    return hit.dataUrl
  }

  /** 결과를 기다리지 않고 캐시만 데운다(다음 조회에서 쓰이도록) */
  prefetch(urlOrHost: string): void {
    void this.get(urlOrHost).catch(() => null)
  }

  /** 파비콘 dataUrl. 캐시 → 사이트 요청 순으로 찾고, 없으면 null */
  async get(urlOrHost: string): Promise<string | null> {
    const host = safeFaviconHost(urlOrHost)
    if (!host) return null

    const hit = this.memory.get(host)
    if (hit && !this.expired(hit)) return hit.dataUrl

    const running = this.inFlight.get(host)
    if (running) return running

    const task = this.resolve(host).finally(() => {
      this.inFlight.delete(host)
    })
    this.inFlight.set(host, task)
    return task
  }

  /**
   * 탭이 실제로 받은 파비콘 URL 을 같은 캐시에 저장한다.
   * 브라우저가 이미 페이지를 여는 김에 알아낸 값이라 추가 노출이 전혀 없고,
   * /favicon.ico 가 없는 사이트도 아이콘을 얻게 된다.
   */
  async storeFromPage(pageUrl: string, iconUrl: string, fetchFn?: FaviconFetch): Promise<void> {
    const host = safeFaviconHost(pageUrl)
    if (!host) return
    if (!/^https?:\/\//i.test(iconUrl)) return
    // 이미 신선한 아이콘이 있으면 페이지를 열 때마다 다시 받지 않는다
    const hit = this.memory.get(host)
    if (hit && hit.dataUrl && !this.expired(hit)) return
    const dataUrl = await this.download(iconUrl, fetchFn)
    if (!dataUrl) return
    this.memory.set(host, { dataUrl, at: this.now() })
    await this.writeCache(host, dataUrl)
  }

  private expired(entry: CacheEntry): boolean {
    const ttl = entry.dataUrl ? FAVICON_TTL_MS : FAVICON_NEGATIVE_TTL_MS
    return this.now() - entry.at >= ttl
  }

  // (a) 디스크 캐시 → (b) 사이트 요청 → (c) 실패 시 null 캐시
  private async resolve(host: string): Promise<string | null> {
    const cached = await this.readCache(host)
    if (cached) {
      this.memory.set(host, cached)
      if (!this.expired(cached)) return cached.dataUrl
    }

    for (const url of [`https://${host}/favicon.ico`, `https://www.${host}/favicon.ico`]) {
      const dataUrl = await this.download(url)
      if (dataUrl) {
        this.memory.set(host, { dataUrl, at: this.now() })
        await this.writeCache(host, dataUrl)
        return dataUrl
      }
    }

    this.memory.set(host, { dataUrl: null, at: this.now() })
    await this.writeCache(host, null)
    return null
  }

  // 한 URL 을 받아 dataUrl 로 만든다. 조건(타임아웃·크기·image/*)을 하나라도 어기면 null
  private async download(url: string, fetchFn?: FaviconFetch): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)
    try {
      const res = await (fetchFn ?? this.fetchFn)(url, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (!res.ok) return null
      const mime = imageMime(res.headers)
      if (!mime) return null
      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > FAVICON_MAX_BYTES) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength === 0 || buf.byteLength > FAVICON_MAX_BYTES) return null
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      // 타임아웃·DNS 실패·TLS 오류 모두 "파비콘 없음"으로 본다
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // 캐시 파일 경로. 호스트는 safeFaviconHost 를 통과한 값이라 경로 이탈이 불가능하다.
  // 실패(null)는 .none 빈 파일로 표시하고, 나이는 파일 mtime 으로 잰다
  private pathOf(host: string, miss = false): string {
    return join(this.cacheDir, `${host}.${miss ? 'none' : 'png'}`)
  }

  private async readCache(host: string): Promise<CacheEntry | null> {
    try {
      const file = this.pathOf(host)
      const info = await stat(file)
      const dataUrl = await readFile(file, 'utf-8')
      if (dataUrl.startsWith('data:image/')) return { dataUrl, at: info.mtimeMs }
    } catch {
      // 없으면 실패 표시를 확인한다
    }
    try {
      const info = await stat(this.pathOf(host, true))
      return { dataUrl: null, at: info.mtimeMs }
    } catch {
      return null
    }
  }

  private async writeCache(host: string, dataUrl: string | null): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true })
      // 확장자는 png 로 고정하되 내용은 dataUrl 문자열이다(mime 을 함께 보존하기 위해서)
      await writeFile(this.pathOf(host, dataUrl === null), dataUrl ?? '', 'utf-8')
    } catch (e: unknown) {
      console.warn('파비콘 캐시 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }
}

// 메인 프로세스 전역 인스턴스. ipc/favicon.ts 가 만들어 넣고,
// tab-manager·bookmarks/newtab 처럼 생성 시점에 주입받기 어려운 곳에서 꺼내 쓴다
let instance: FaviconService | null = null

export function setFaviconService(service: FaviconService | null): void {
  instance = service
}

export function getFaviconService(): FaviconService | null {
  return instance
}
