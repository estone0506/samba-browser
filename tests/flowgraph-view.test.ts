// 흐름 그래프의 표시 로직 — 어느 노드가 도는 중인지, 사람 승인을 기다리는지
import { describe, it, expect } from 'vitest'
import {
  columnsOf,
  connectionKeyOf,
  jobLineOf,
  matchTextOf,
  nodeStatusOf,
  stageOfKind,
  waitingStageOf
} from '@renderer/components/automation/flowgraph-view'
import type { HarnessAgent, HarnessGraph, HarnessJob } from '@shared/harness'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

function agent(patch: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    name: 'buyer.musinsa',
    kind: 'buyer',
    match: { source: 'musinsa', seller: 'poison' },
    tools: ['page.get', 'run_js'],
    rules: 'rules/buyer_musinsa.md',
    retry: 1,
    ...patch
  }
}

function job(patch: Partial<HarnessJob> = {}): HarnessJob {
  return {
    order_no: '734501000740906',
    state: 'running',
    assignee_agent: 'buyer.musinsa',
    step: '옵션 선택',
    requester: 'U123',
    harness_version: 'v1',
    attempts: 0,
    updated_at: '2026-09-22T01:00:00Z',
    ...patch
  }
}

const graph: HarnessGraph = {
  version: 'v1',
  stages: ['buy', 'pay', 'record', 'verify'],
  agents: [
    agent(),
    agent({ name: 'buyer.29cm', match: { source: '29cm' } }),
    agent({ name: 'payer', kind: 'payer', match: {}, rules: 'rules/payer.md', retry: 0 }),
    agent({ name: 'recorder', kind: 'recorder', match: {}, rules: 'rules/recorder.md' }),
    agent({ name: 'verifier', kind: 'verifier', match: {}, rules: 'rules/verifier.md' })
  ]
}

describe('단계 배치', () => {
  it('kind 로 단계를 정한다', () => {
    expect(stageOfKind('buyer')).toBe('buy')
    expect(stageOfKind('payer')).toBe('pay')
    expect(stageOfKind('recorder')).toBe('record')
    expect(stageOfKind('verifier')).toBe('verify')
  })

  it('단계 순서대로 열을 만들고, 같은 단계의 에이전트는 함께 묶는다', () => {
    const cols = columnsOf(graph)
    expect(cols.map((c) => c.stage)).toEqual(['buy', 'pay', 'record', 'verify'])
    expect(cols[0].agents.map((a) => a.name)).toEqual(['buyer.musinsa', 'buyer.29cm'])
    expect(cols[1].agents).toHaveLength(1)
  })
})

describe('노드 상태', () => {
  it('담당 에이전트가 도는 중이면 running, 다른 노드는 idle', () => {
    expect(nodeStatusOf(agent(), [job()])).toBe('running')
    expect(nodeStatusOf(agent({ name: 'payer', kind: 'payer' }), [job()])).toBe('idle')
  })

  it('승인 대기는 그 단계 노드를 waiting 으로 칠한다', () => {
    const waiting = job({ assignee_agent: 'approval.pay', step: '승인 대기: pay' })
    expect(waitingStageOf(waiting.step)).toBe('pay')
    expect(nodeStatusOf(agent({ name: 'payer', kind: 'payer' }), [waiting])).toBe('waiting')
    expect(nodeStatusOf(agent(), [waiting])).toBe('idle')
  })

  it('needs_human 은 담당 노드를 attention 으로 칠한다', () => {
    expect(nodeStatusOf(agent(), [job({ state: 'needs_human' })])).toBe('attention')
  })

  it('끝난 작업은 아무 노드도 칠하지 않는다', () => {
    expect(nodeStatusOf(agent(), [job({ state: 'done' })])).toBe('idle')
    expect(nodeStatusOf(agent(), [])).toBe('idle')
  })
})

describe('문구', () => {
  it('담당 조건은 키=값 으로 한 줄이 된다', () => {
    expect(matchTextOf(agent())).toBe('source=musinsa · seller=poison')
    expect(matchTextOf(agent({ match: {} }))).toBe('')
  })

  it('작업 한 줄은 상태 키·단계·사람 확인 여부를 준다', () => {
    const line = jobLineOf(job({ state: 'needs_human', step: '승인 대기: pay' }))
    expect(line.stateKey).toBe('automation.harness.state.needs_human')
    expect(line.needsHuman).toBe(true)
    expect(line.step).toBe('승인 대기: pay')
    expect(jobLineOf(job()).needsHuman).toBe(false)
  })

  it('연결 상태 문구 키는 ko·en 양쪽에 있다', () => {
    for (const status of ['ok', 'offline', 'timeout', 'bad-response', 'bad-url'] as const) {
      const key = connectionKeyOf(status)
      const path = key.split('.')
      const read = (src: Record<string, unknown>): unknown =>
        path.reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], src)
      expect(read(ko as unknown as Record<string, unknown>), key).toBeTypeOf('string')
      expect(read(en as unknown as Record<string, unknown>), key).toBeTypeOf('string')
    }
  })
})

describe('FlowGraph·RulesDialog 가 쓰는 i18n 키(ko·en 양쪽)', () => {
  const keys = [
    'automation.harness.title',
    'automation.harness.desc',
    'automation.harness.version',
    'automation.harness.refresh',
    'automation.harness.expand',
    'automation.harness.collapse',
    'automation.harness.empty',
    'automation.harness.stage.buy',
    'automation.harness.stage.pay',
    'automation.harness.stage.record',
    'automation.harness.stage.verify',
    'automation.harness.node.supervisor',
    'automation.harness.node.retry',
    'automation.harness.node.noRetry',
    'automation.harness.node.tools',
    'automation.harness.node.edit',
    'automation.harness.node.status.running',
    'automation.harness.node.status.waiting',
    'automation.harness.node.status.attention',
    'automation.harness.rules.title',
    'automation.harness.rules.path',
    'automation.harness.rules.loading',
    'automation.harness.rules.loadFailed',
    'automation.harness.rules.retry',
    'automation.harness.rules.warn',
    'automation.harness.rules.newVersion',
    'automation.harness.rules.placeholder',
    'automation.harness.rules.save',
    'automation.harness.rules.confirm',
    'automation.harness.rules.confirmDesc',
    'automation.harness.rules.cancel',
    'automation.harness.rules.saved',
    'automation.harness.rules.failed'
  ]

  const read = (src: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], src)

  it.each(keys)('%s', (key) => {
    expect(read(ko as unknown as Record<string, unknown>, key)).toBeTypeOf('string')
    expect(read(en as unknown as Record<string, unknown>, key)).toBeTypeOf('string')
  })
})
