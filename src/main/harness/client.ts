// 하네스(samba-agent) 읽기 API 클라이언트. 브릿지와 반대 방향(앱 → 하네스)이다.
//
// 규칙
// - 127.0.0.1(또는 localhost)의 http 주소만 부른다. 다른 주소는 아예 부르지 않는다
// - 던지지 않는다. 꺼짐·타임아웃·엉뚱한 응답을 전부 status 로 돌려준다(하네스가 꺼져 있는 건 정상이다)
// - 바꾸는 요청은 putRules 하나뿐이다. 나머지는 읽기다(getRules 포함)
import type { z } from 'zod'
import {
  harnessGraphSchema,
  harnessJobsSchema,
  harnessReleasesSchema,
  harnessRulesSchema,
  harnessRulesSavedSchema,
  type HarnessGraph,
  type HarnessJobs,
  type HarnessReleases,
  type HarnessRules,
  type HarnessRulesSaved
} from '../../shared/harness'

export type HarnessStatus = 'ok' | 'offline' | 'timeout' | 'bad-response' | 'bad-url'

export interface HarnessResult<T> {
  status: HarnessStatus
  data: T | null
  /** 사람이 읽는 사유(성공이면 빈 문자열) */
  error: string
}

export interface HarnessDeps {
  /** 지금 설정의 주소(호출마다 다시 읽는다 — 설정을 고치면 바로 반영된다) */
  url: () => string
  fetchImpl?: typeof globalThis.fetch
  /** 한 요청 제한 시간(ms). 기본 4000 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4000
// URL 의 hostname 은 IPv6 를 대괄호 없이 준다('::1'), 하지만 그 URL 은 실제로
// '[::1]' 로 써야 붙는다 — 여기 목록은 URL.hostname 이 주는 꼴이 아니라
// 사람이 설정에 적는 원문과 비교해야 하므로 대괄호를 그대로 둔다(리뷰 지적 — Minor 4)
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]']
/** 오류 본문은 화면에 한 줄로만 보인다 */
const ERROR_TEXT_MAX = 200
/** 성공 응답 본문 상한(리뷰 지적 — Minor 4). 넘으면 하네스가 이상해진 것으로 보고 bad-response */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** 설정 주소를 검사해 기준 주소(origin)로 바꾼다. 로컬이 아니면 null */
export function localHarnessBase(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:') return null
    if (!LOCAL_HOSTS.includes(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

export class HarnessClient {
  constructor(private readonly deps: HarnessDeps) {}

  graph(): Promise<HarnessResult<HarnessGraph>> {
    return this.request('GET', '/graph', harnessGraphSchema)
  }

  jobs(): Promise<HarnessResult<HarnessJobs>> {
    return this.request('GET', '/jobs', harnessJobsSchema)
  }

  releases(): Promise<HarnessResult<HarnessReleases>> {
    return this.request('GET', '/releases', harnessReleasesSchema)
  }

  /** 에이전트 규칙 파일 전체를 읽는다(편집 모달을 채우는 용도) */
  getRules(agent: string): Promise<HarnessResult<HarnessRules>> {
    return this.request('GET', `/graph/rules/${encodeURIComponent(agent)}`, harnessRulesSchema)
  }

  /** 규칙 파일 전체 교체. 고치면 새 harness_version 이 되어 판정을 다시 통과해야 한다 */
  putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>> {
    return this.request(
      'PUT',
      `/graph/rules/${encodeURIComponent(agent)}`,
      harnessRulesSavedSchema,
      { text }
    )
  }

  private async request<T>(
    method: 'GET' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    body?: { text: string }
  ): Promise<HarnessResult<T>> {
    const base = localHarnessBase(this.deps.url())
    if (base === null) return { status: 'bad-url', data: null, error: this.deps.url() }
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        signal: abort.signal,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      })
      const text = await res.text()
      if (!res.ok) {
        return {
          status: 'bad-response',
          data: null,
          error: `HTTP ${res.status}: ${text.slice(0, ERROR_TEXT_MAX)}`
        }
      }
      // 본문이 지나치게 크면 하네스가 이상해진 것이다 — 다 읽어 파싱하지 않고 바로 거절한다
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        return { status: 'bad-response', data: null, error: 'response too large' }
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return { status: 'bad-response', data: null, error: text.slice(0, ERROR_TEXT_MAX) }
      }
      // 200 이어도 모양이 다르면(예: {"detail":"x"}) 화면이 엉뚱한 값으로 죽지 않게
      // 여기서 걸러 bad-response 로 돌린다(리뷰 지적 — Important 1)
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        return { status: 'bad-response', data: null, error: text.slice(0, ERROR_TEXT_MAX) }
      }
      return { status: 'ok', data: parsed.data, error: '' }
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { status: 'timeout', data: null, error: 'timeout' }
      }
      return { status: 'offline', data: null, error: e instanceof Error ? e.message : String(e) }
    } finally {
      clearTimeout(timer)
    }
  }
}
