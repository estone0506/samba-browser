// 하네스 작업 목록(GET /jobs) — 상태·단계·담당 에이전트·사람 확인 여부.
// 살아 있는 작업만 온다(하네스의 queue.live())
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { HarnessJob } from '@shared/harness'
import { StatusBadge } from '@renderer/components/settings/shared'
import { jobLineOf } from './flowgraph-view'

export function JobList({ jobs }: { jobs: HarnessJob[] }): React.JSX.Element {
  const { t } = useTranslation()
  if (jobs.length === 0) {
    return (
      <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-3 text-center text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.jobs.empty')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {jobs.map((job) => {
        const line = jobLineOf(job)
        return (
          <li
            key={job.order_no}
            className="rounded-[9px] border border-[var(--line)] bg-white p-2 text-[11.5px]"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--text)]">
                {t('automation.harness.jobs.order', { orderNo: job.order_no })}
              </span>
              <StatusBadge label={t(line.stateKey)} tone={line.needsHuman ? 'warn' : 'neutral'} />
              {line.needsHuman && (
                <StatusBadge label={t('automation.harness.jobs.needsHuman')} tone="warn" />
              )}
            </div>
            <p className="mt-0.5 truncate text-[var(--text2)]">
              {[
                line.step,
                job.assignee_agent === null
                  ? ''
                  : t('automation.harness.jobs.agent', { agent: job.assignee_agent }),
                t('automation.harness.jobs.requester', { requester: job.requester }),
                job.attempts > 0 ? t('automation.harness.jobs.attempts', { n: job.attempts }) : ''
              ]
                .filter((s) => s !== '')
                .join(' · ')}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
