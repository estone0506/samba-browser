// Codex 구독 사용량 조회 — 설정의 Codex 구독 카드가 보여 준다.
//
// Codex CLI 의 /status 와 같은 조회다: 이 PC 의 CLI 로그인 자격(~/.codex/auth.json)으로
// ChatGPT 백엔드의 사용량 API 를 부른다. **토큰·계정 id 는 이 모듈 밖으로 나가지 않는다** —
// 로그·IPC·렌더러 어디에도 싣지 않고, 돌려주는 것은 비율과 재설정 시각뿐이다.
// 조회가 안 되면(오프라인·형식 변경·자격 없음) null 을 돌려주고 화면은 사용량 줄을 숨긴다.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AiUsage, AiUsageLimit } from '../../shared/ai'

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_USAGE_TIMEOUT_MS = 8000
const CODEX_AUTH_FILE = join(homedir(), '.codex', 'auth.json')

/** 이 길이(초) 이하의 창은 "세션"(5시간), 그보다 길면 "주간 전체"로 본다 */
const SESSION_WINDOW_MAX_SECONDS = 6 * 60 * 60

const windowSchema = z
  .object({
    used_percent: z.number(),
    limit_window_seconds: z.number().nullable().optional(),
    reset_at: z.number().nullable().optional()
  })
  .nullable()
  .optional()

const usageSchema = z.object({
  rate_limit: z
    .object({ primary_window: windowSchema, secondary_window: windowSchema })
    .nullable()
    .optional()
})

/** API 응답 → 화면용 한도 목록(순수 함수). 창이 하나도 없으면 빈 배열, 모양이 다르면 null */
export function parseCodexUsage(raw: unknown): AiUsageLimit[] | null {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return null
  const out: AiUsageLimit[] = []
  const rl = parsed.data.rate_limit
  for (const w of [rl?.primary_window, rl?.secondary_window]) {
    if (!w) continue
    const seconds = w.limit_window_seconds ?? 0
    out.push({
      kind: seconds > 0 && seconds <= SESSION_WINDOW_MAX_SECONDS ? 'session' : 'weekly_all',
      percent: Math.max(0, Math.min(100, Math.round(w.used_percent))),
      resetsAt:
        typeof w.reset_at === 'number' && w.reset_at > 0
          ? new Date(w.reset_at * 1000).toISOString()
          : null
    })
  }
  // 세션 창이 앞에 오게(Claude 카드와 같은 순서)
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1))
  return out
}

export interface CodexAuth {
  token: string
  accountId: string | null
}

/** 자격 파일에서 액세스 토큰과 계정 id 만 꺼낸다. 없거나 깨졌으면 null(값은 로그에 남기지 않는다) */
export function readCodexAuth(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')
): CodexAuth | null {
  try {
    const json: unknown = JSON.parse(readFile(CODEX_AUTH_FILE))
    const tokens = (json as { tokens?: { access_token?: unknown; account_id?: unknown } }).tokens
    const token = tokens?.access_token
    if (typeof token !== 'string' || token === '') return null
    const accountId = tokens?.account_id
    return {
      token,
      accountId: typeof accountId === 'string' && accountId !== '' ? accountId : null
    }
  } catch {
    return null
  }
}

export interface CodexUsageDeps {
  readAuth?: () => CodexAuth | null
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** 지금 붙어 있는 Codex 계정의 사용량. 조회가 안 되면 null */
export async function fetchCodexUsage(deps: CodexUsageDeps = {}): Promise<AiUsage | null> {
  const auth = (deps.readAuth ?? readCodexAuth)()
  if (!auth) return null
  const doFetch = deps.fetch ?? fetch
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS)
  try {
    const res = await doFetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {})
      },
      signal: abort.signal
    })
    if (!res.ok) return null
    const limits = parseCodexUsage(await res.json())
    if (!limits) return null
    return { limits, fetchedAt: (deps.now ?? Date.now)() }
  } catch {
    // 오프라인·시간 초과. 사유에 토큰이 섞일 수 있어 아무것도 남기지 않는다
    return null
  } finally {
    clearTimeout(timer)
  }
}
