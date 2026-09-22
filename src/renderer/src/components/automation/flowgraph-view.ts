// 흐름 그래프의 순수 표시 로직(React 없음 — 단위 테스트에서 그대로 부른다).
//
// 문구는 i18n 키만 돌려주고 번역은 컴포넌트가 t() 로 한다.
// 여기서 정하는 것은 "어느 노드를 무슨 색으로 칠할지"와 "한 줄에 무엇을 쓸지"뿐이다

import {
  HARNESS_STAGES,
  type AgentKind,
  type HarnessAgent,
  type HarnessGraph,
  type HarnessJob,
  type HarnessStage
} from '@shared/harness'
import type { HarnessStatus } from '../../../../main/harness/client'

/** 노드 색. running=도는 중, waiting=사람 승인 대기, attention=사람 확인 필요 */
export type NodeStatus = 'idle' | 'running' | 'waiting' | 'attention'

const STAGE_OF_KIND: Record<AgentKind, HarnessStage> = {
  buyer: 'buy',
  payer: 'pay',
  recorder: 'record',
  verifier: 'verify'
}

export function stageOfKind(kind: AgentKind): HarnessStage {
  return STAGE_OF_KIND[kind]
}

/** '승인 대기: pay' → 'pay'. 승인 대기가 아니면 null */
export function waitingStageOf(step: string | null): HarnessStage | null {
  if (step === null) return null
  const m = /^승인 대기:\s*(\w+)/.exec(step)
  const stage = m?.[1]
  return stage !== undefined && (HARNESS_STAGES as readonly string[]).includes(stage)
    ? (stage as HarnessStage)
    : null
}

/** 감독자가 넘기는 순서대로 열을 만든다. 등록부에 없는 단계는 빈 열로 남는다 */
export function columnsOf(
  graph: HarnessGraph
): Array<{ stage: HarnessStage; agents: HarnessAgent[] }> {
  return HARNESS_STAGES.map((stage) => ({
    stage,
    agents: graph.agents.filter((a) => stageOfKind(a.kind) === stage)
  }))
}

/** 살아 있는 작업만 노드를 칠한다(done·failed·cancelled 은 지나간 일이다) */
export function nodeStatusOf(agent: HarnessAgent, jobs: HarnessJob[]): NodeStatus {
  let status: NodeStatus = 'idle'
  for (const job of jobs) {
    const waiting = waitingStageOf(job.step)
    if (waiting !== null && waiting === stageOfKind(agent.kind)) return 'waiting'
    if (job.assignee_agent !== agent.name) continue
    if (job.state === 'needs_human') return 'attention'
    if (job.state === 'running') status = 'running'
  }
  return status
}

/** 담당 조건 한 줄 — 'source=musinsa · seller=poison' */
export function matchTextOf(agent: HarnessAgent): string {
  return Object.entries(agent.match)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
}

/** 작업 목록 한 줄 */
export function jobLineOf(job: HarnessJob): {
  stateKey: string
  step: string
  needsHuman: boolean
} {
  return {
    stateKey: `automation.harness.state.${job.state}`,
    step: job.step ?? '',
    needsHuman: job.state === 'needs_human' || waitingStageOf(job.step) !== null
  }
}

/** 연결 상태 문구 키 */
export function connectionKeyOf(status: HarnessStatus): string {
  if (status === 'ok') return 'automation.harness.conn.ok'
  if (status === 'timeout') return 'automation.harness.conn.timeout'
  if (status === 'bad-response') return 'automation.harness.conn.badResponse'
  if (status === 'bad-url') return 'automation.harness.conn.badUrl'
  return 'automation.harness.conn.offline'
}
