// 하네스 실기 응답으로 파서·뷰 로직이 깨지지 않는지 확인하는 통합 테스트.
//
// 메인 클라이언트(HarnessClient)의 단위 테스트는 mock 응답만 쓴다 — 이 테스트는
// 실제로 도는 하네스(127.0.0.1:47812)에 붙어 응답을 그대로 흐름 그래프·판정 리포트
// 파서에 흘려 본다. 하네스가 꺼져 있으면(개발자 PC 마다 다르다) 통째로 건너뛴다
import { describe, expect, it } from 'vitest'
import { HarnessClient } from '../src/main/harness/client'
import { columnsOf, nodeStatusOf } from '../src/renderer/src/components/automation/flowgraph-view'
import { parseGateReport } from '../src/shared/harness'

const HARNESS_URL = 'http://127.0.0.1:47812'

async function isHarnessUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HARNESS_URL}/graph`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const harnessUp = await isHarnessUp()

describe.skipIf(!harnessUp)('하네스 실기 응답 — 파서·뷰 로직 회귀', () => {
  const client = new HarnessClient({ url: () => HARNESS_URL })

  it('GET /graph 응답이 흐름 그래프 열 나누기·노드 상태 계산을 깨지 않는다', async () => {
    const graph = await client.graph()
    expect(graph.status).toBe('ok')
    expect(graph.data).not.toBeNull()
    if (graph.data === null) return

    const columns = columnsOf(graph.data)
    // 등록부의 모든 에이전트는 네 열(구매·결제·기록·검증) 중 정확히 하나에 들어간다
    const placed = columns.reduce((n, c) => n + c.agents.length, 0)
    expect(placed).toBe(graph.data.agents.length)

    const jobs = await client.jobs()
    expect(jobs.status).toBe('ok')
    const jobList = jobs.data?.jobs ?? []
    for (const agent of graph.data.agents) {
      // 상태 계산이 예외 없이 네 값 중 하나로 떨어져야 한다
      expect(['idle', 'running', 'waiting', 'attention']).toContain(nodeStatusOf(agent, jobList))
    }
  })

  it('GET /releases 후보 리포트가 있으면 판정 파서가 여섯 조건을 읽는다', async () => {
    const releases = await client.releases()
    // /releases 는 판정이 아직 안 돌았거나 하네스 쪽 사정으로 오류를 줄 수도 있다(정상 범위) —
    // 여기서 확인할 것은 클라이언트가 던지지 않는다는 것과, 응답이 있을 때 파서가 깨지지 않는다는 것
    expect(['ok', 'bad-response', 'offline', 'timeout']).toContain(releases.status)
    const candidate = releases.status === 'ok' ? (releases.data?.candidate ?? null) : null
    if (candidate === null) return
    const report = parseGateReport(candidate.report)
    expect(Object.keys(report.checks)).toEqual([
      'observe',
      'accuracy',
      'regression',
      'dry_run',
      'review_queue',
      'approval'
    ])
  })
})
