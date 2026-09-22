// 하네스(samba-agent) 읽기 API 의 응답 모양과 판정 리포트 읽기. 메인·렌더러 양쪽에서 쓴다.
//
// 진실은 하네스 코드다 — samba-agent/src/samba_agent/api/server.py(응답),
// ops/gate.py(판정 조건·리포트 마크다운), ops/releases.py(Release).
// 앱은 읽기만 한다. 승격·승인은 슬랙 `@삼바 승인 <버전>` 또는 명령줄에서만 일어난다(스펙 §10-4)

/** 감독자가 넘기는 순서. 하네스 supervisor/policy.py 의 STAGES 와 같다 */
export const HARNESS_STAGES = ['buy', 'pay', 'record', 'verify'] as const
export type HarnessStage = (typeof HARNESS_STAGES)[number]

/** 판정 여섯 조건(ops/gate.py GATE_RULES). 하나라도 미달이면 improve */
export const GATE_RULES = [
  'observe',
  'accuracy',
  'regression',
  'dry_run',
  'review_queue',
  'approval'
] as const
export type GateRule = (typeof GATE_RULES)[number]

export type AgentKind = 'buyer' | 'payer' | 'recorder' | 'verifier'

/** 등록부 한 행(agents/registry.yaml) */
export interface HarnessAgent {
  name: string
  kind: AgentKind
  /** 담당 조건(소싱처·판매처 등). 값은 하네스가 정하므로 문자열 지도로만 받는다 */
  match: Record<string, string>
  /** 브릿지 도구 허용 목록 */
  tools: string[]
  /** 규칙 파일 경로(하네스 저장소 기준 상대 경로) */
  rules: string
  retry: number
}

export interface HarnessGraph {
  version: string
  stages: string[]
  agents: HarnessAgent[]
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'needs_human' | 'cancelled'

export interface HarnessJob {
  order_no: string
  state: JobState
  assignee_agent: string | null
  /** 진행 단계 설명. '승인 대기: pay' 처럼 오면 사람 승인 대기다 */
  step: string | null
  requester: string
  harness_version: string
  attempts: number
  updated_at: string
}

export interface HarnessJobs {
  jobs: HarnessJob[]
}

export interface HarnessRelease {
  version: string
  verdict: 'promote' | 'improve' | 'rollback'
  decided_by: string
  decided_at: string
  report_path: string
  prompt_commits: Record<string, string>
}

export interface HarnessReleases {
  current: HarnessRelease | null
  history: HarnessRelease[]
  /** 지금 코드·규칙·프롬프트가 만드는 후보 버전의 판정 리포트(md 본문). 판정 전이면 null */
  candidate: { version: string; report: string } | null
}

/** 규칙 파일 저장 응답 */
export interface HarnessRulesSaved {
  ok: boolean
  version: string
}

/** 판정 리포트에서 읽어 낸 것 */
export interface GateReport {
  version: string
  verdict: 'promote' | 'improve' | null
  /** 여섯 조건. 표에 없으면 null(모름) — 없는 것을 통과로 읽지 않는다 */
  checks: Record<GateRule, boolean | null>
  reasons: string[]
}

const HEAD_RE = /^#\s*판정\s*—\s*(\S+)\s*:\s*\*\*(promote|improve)\*\*/m
const ROW_RE = /^\|\s*([a-z_]+)\s*\|\s*(통과|미달)\s*\|/gm
const REASONS_RE = /^##\s*다음 할 일\s*$/m

/**
 * 하네스가 만든 판정 리포트(ops/reports/<version>.md) 를 읽는다.
 * JSON 이 아니라 사람이 읽는 표라서 여기서 한 번만 해석하고, 화면은 결과만 쓴다
 */
export function parseGateReport(md: string): GateReport {
  const checks = Object.fromEntries(GATE_RULES.map((r) => [r, null])) as Record<
    GateRule,
    boolean | null
  >
  const head = HEAD_RE.exec(md)
  for (const m of md.matchAll(ROW_RE)) {
    const rule = m[1] as GateRule
    if ((GATE_RULES as readonly string[]).includes(rule)) checks[rule] = m[2] === '통과'
  }
  const reasons: string[] = []
  const at = REASONS_RE.exec(md)
  if (at) {
    for (const line of md.slice(at.index + at[0].length).split('\n')) {
      const text = line.trim()
      if (text.startsWith('- ')) reasons.push(text.slice(2).trim())
      else if (text.startsWith('#')) break
    }
  }
  return {
    version: head ? head[1] : '',
    verdict: head ? (head[2] as 'promote' | 'improve') : null,
    checks,
    reasons
  }
}
