// 플레이북 카드 아래 붙는 "처리 흐름" 패널 — 흐름 그래프 + 작업 목록 + 판정 카드.
//
// 기본은 접혀 있다. 펼칠 때만 하네스를 읽고(5초 폴링), 접으면 멈춘다 —
// 하네스가 꺼져 있어도 자동화 페이지는 그대로 쓸 수 있어야 하기 때문이다
import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { HarnessAgent } from '@shared/harness'
import { useHarnessStore } from '@renderer/stores/harnessStore'
import { SecondaryButton } from '@renderer/components/settings/shared'
import { connectionKeyOf } from './flowgraph-view'
import { FlowGraph } from './FlowGraph'
import { JobList } from './JobList'
import { RulesDialog } from './RulesDialog'
import { VerdictCard } from './VerdictCard'

export function HarnessPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<HarnessAgent | null>(null)
  // 저장 성공 알림에 쓸 새 버전(rules.saved 는 브리프 이후 죽은 키였다 — 실제로 연결한다.
  // 리뷰 지적 — Minor 8). null 이면 안 보인다
  const [savedVersion, setSavedVersion] = useState<string | null>(null)
  const graph = useHarnessStore((s) => s.graph)
  const jobs = useHarnessStore((s) => s.jobs)
  const releases = useHarnessStore((s) => s.releases)
  const status = useHarnessStore((s) => s.status)
  const saving = useHarnessStore((s) => s.saving)
  const saveError = useHarnessStore((s) => s.saveError)
  const refresh = useHarnessStore((s) => s.refresh)
  const start = useHarnessStore((s) => s.start)
  const putRules = useHarnessStore((s) => s.putRules)

  useEffect(() => {
    if (!open) return
    return start()
  }, [open, start])

  // 몇 초 뒤 스스로 사라진다 — 계속 떠 있을 이유가 없다
  useEffect(() => {
    if (savedVersion === null) return
    const id = setTimeout(() => setSavedVersion(null), 4000)
    return () => clearTimeout(id)
  }, [savedVersion])

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
          {t('automation.harness.title')}
        </h2>
        {open && graph !== null && (
          <span className="truncate font-mono text-[11px] text-[var(--text2)]">
            {t('automation.harness.version', { version: graph.version })}
          </span>
        )}
        <SecondaryButton onClick={() => setOpen(!open)}>
          <span className="flex items-center gap-1.5">
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {t(open ? 'automation.harness.collapse' : 'automation.harness.expand')}
          </span>
        </SecondaryButton>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {savedVersion !== null && (
            <p className="rounded-[9px] border border-[#15803d] px-2.5 py-2 text-[11.5px] text-[#15803d]">
              {t('automation.harness.rules.saved', { version: savedVersion })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={`min-w-0 flex-1 truncate text-[11.5px] ${
                status === 'ok' ? 'text-[var(--text2)]' : 'text-[#b45309]'
              }`}
            >
              {t(connectionKeyOf(status))}
            </p>
            <SecondaryButton onClick={() => void refresh()}>
              {t('automation.harness.refresh')}
            </SecondaryButton>
          </div>
          <p className="text-[11.5px] text-[var(--text2)]">{t('automation.harness.desc')}</p>

          {graph !== null && (
            <FlowGraph graph={graph} jobs={jobs} onEditRules={(agent) => setEditing(agent)} />
          )}

          <div>
            <h3 className="text-[12px] font-semibold text-[var(--text)]">
              {t('automation.harness.jobs.title')}
            </h3>
            <div className="mt-1.5">
              <JobList jobs={jobs} />
            </div>
          </div>

          {releases !== null && <VerdictCard releases={releases} />}
        </div>
      )}

      <RulesDialog
        agent={editing}
        open={editing !== null}
        saving={saving}
        error={saveError}
        onOpenChange={(v) => {
          if (!v) setEditing(null)
        }}
        onSave={async (text) => {
          const ok = await putRules(editing?.name ?? '', text)
          // putRules 가 성공하면 안에서 그래프를 다시 읽어 두므로, 그 새 버전을 그대로 보인다
          if (ok) setSavedVersion(useHarnessStore.getState().graph?.version ?? '')
          return ok
        }}
      />
    </section>
  )
}
