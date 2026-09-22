// 감독자 → 전문 에이전트 흐름 그래프.
//
// 단계(구매·결제·기록·검증)를 열로 두고, 등록부의 에이전트를 그 열에 담는다.
// 지금 도는 작업의 담당 노드는 색으로 칠하고, 승인 대기는 따로 표시한다.
// 좁은 화면에서는 열이 세로로 쌓인다(가로 스크롤 없음)
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Pencil } from 'lucide-react'
import type { HarnessAgent, HarnessGraph, HarnessJob } from '@shared/harness'
import { StatusBadge } from '@renderer/components/settings/shared'
import { columnsOf, matchTextOf, nodeStatusOf, type NodeStatus } from './flowgraph-view'

const NODE_TONE: Record<NodeStatus, string> = {
  idle: 'border-[var(--line)] bg-white',
  running: 'border-[#2563eb] bg-[#eff6ff]',
  waiting: 'border-[#b45309] bg-[#fffbeb]',
  attention: 'border-[#b91c1c] bg-[#fef2f2]'
}

export function FlowGraph({
  graph,
  jobs,
  onEditRules
}: {
  graph: HarnessGraph
  jobs: HarnessJob[]
  onEditRules: (agent: HarnessAgent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const columns = columnsOf(graph)
  if (graph.agents.length === 0) {
    return (
      <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-3 text-center text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.empty')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--bg2)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--text)]">
        {t('automation.harness.node.supervisor')}
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        {columns.map((column, i) => (
          <div key={column.stage} className="flex min-w-0 flex-1 items-stretch gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-[11px] font-semibold text-[var(--text2)]">
                {t(`automation.harness.stage.${column.stage}`)}
              </p>
              {column.agents.map((agent) => (
                <AgentNode
                  key={agent.name}
                  agent={agent}
                  status={nodeStatusOf(agent, jobs)}
                  onEdit={() => onEditRules(agent)}
                />
              ))}
            </div>
            {i < columns.length - 1 && (
              <ChevronRight
                className="hidden h-4 w-4 shrink-0 self-center text-[var(--text2)] md:block"
                aria-hidden
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentNode({
  agent,
  status,
  onEdit
}: {
  agent: HarnessAgent
  status: NodeStatus
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const match = matchTextOf(agent)
  return (
    <div className={`rounded-[9px] border p-2 ${NODE_TONE[status]}`}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text)]">
          {agent.name}
        </span>
        {status !== 'idle' && (
          <StatusBadge
            label={t(`automation.harness.node.status.${status}`)}
            tone={status === 'running' ? 'strong' : 'warn'}
          />
        )}
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('automation.harness.node.edit')}
          title={t('automation.harness.node.edit')}
          className="rounded p-1 text-[var(--text2)] hover:bg-[var(--bg2)]"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      {match !== '' && <p className="mt-1 truncate text-[11px] text-[var(--text2)]">{match}</p>}
      <p className="mt-0.5 text-[11px] text-[var(--text2)]">
        {agent.retry > 0
          ? t('automation.harness.node.retry', { n: agent.retry })
          : t('automation.harness.node.noRetry')}
        {' · '}
        {t('automation.harness.node.tools', { n: agent.tools.length })}
      </p>
    </div>
  )
}
