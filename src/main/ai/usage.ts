// Claude 구독 사용량 조회 — 설정의 Claude 구독 카드가 보여 준다.
//
// Claude Code 의 /usage 와 같은 조회다: 이 PC 의 CLI 로그인 자격(~/.claude/.credentials.json)으로
// Anthropic 의 사용량 API 를 부른다. **토큰은 이 모듈 밖으로 나가지 않는다** — 로그·IPC·렌더러
// 어디에도 싣지 않고, 돌려주는 것은 비율과 재설정 시각뿐이다.
// 조회가 안 되면(오프라인·형식 변경·자격 없음) null 을 돌려주고 화면은 사용량 줄을 숨긴다.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AiUsage, AiUsageLimit } from '../../shared/ai'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CLAUDE_USAGE_TIMEOUT_MS = 8000
const CLAUDE_OAUTH_FILE = join(homedir(), '.claude', '.credentials.json')

const limitSchema = z.object({
  kind: z.string(),
  percent: z.number(),
  resets_at: z.string().nullable().optional(),
  scope: z
    .object({
      model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional()
    })
    .nullable()
    .optional()
})

const usageSchema = z.object({ limits: z.array(limitSchema) })

const KINDS: readonly AiUsageLimit['kind'][] = ['session', 'weekly_all', 'weekly_scoped']

/** API 응답 → 화면용 한도 목록. 모르는 종류는 버린다(순수 함수) */
export function parseClaudeUsage(raw: unknown): AiUsageLimit[] | null {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return null
  const out: AiUsageLimit[] = []
  for (const l of parsed.data.limits) {
    const kind = KINDS.find((k) => k === l.kind)
    if (!kind) continue
    const model = l.scope?.model?.display_name ?? undefined
    out.push({
      kind,
      percent: Math.max(0, Math.min(100, Math.round(l.percent))),
      resetsAt: l.resets_at ?? null,
      ...(model ? { model } : {})
    })
  }
  return out
}

/** 자격 파일에서 액세스 토큰만 꺼낸다. 없거나 깨졌으면 null(값은 로그에 남기지 않는다) */
export function readClaudeAccessToken(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')
): string | null {
  try {
    const json: unknown = JSON.parse(readFile(CLAUDE_OAUTH_FILE))
    const oauth = (json as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
    const token = oauth?.accessToken
    return typeof token === 'string' && token !== '' ? token : null
  } catch {
    return null
  }
}

export interface ClaudeUsageDeps {
  readToken?: () => string | null
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** 지금 붙어 있는 Claude 계정의 사용량. 조회가 안 되면 null */
export async function fetchClaudeUsage(deps: ClaudeUsageDeps = {}): Promise<AiUsage | null> {
  const token = (deps.readToken ?? readClaudeAccessToken)()
  if (!token) return null
  const doFetch = deps.fetch ?? fetch
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS)
  try {
    const res = await doFetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: abort.signal
    })
    if (!res.ok) return null
    const limits = parseClaudeUsage(await res.json())
    if (!limits) return null
    return { limits, fetchedAt: (deps.now ?? Date.now)() }
  } catch {
    // 오프라인·시간 초과. 사유에 토큰이 섞일 수 있어 아무것도 남기지 않는다
    return null
  } finally {
    clearTimeout(timer)
  }
}
