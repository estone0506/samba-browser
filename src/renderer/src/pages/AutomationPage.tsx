import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { runPhraseOf, type PlaybookInput } from '@shared/playbook'
import type { PlaybookSchedule } from '@shared/schedule'
import { usePlaybookStore } from '@renderer/stores/playbookStore'
import { useScheduleStore } from '@renderer/stores/scheduleStore'
import { useChatStore } from '@renderer/stores/chatStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { PrimaryButton } from '@renderer/components/settings/shared'
import { PlaybookCard } from '@renderer/components/automation/PlaybookCard'
import { PlaybookEditor } from '@renderer/components/automation/PlaybookEditor'

// 편집 중인 대상. 'new' 는 새로 만들기 폼, 문자열 id 는 그 카드의 편집 폼
type EditTarget = 'new' | string | null

/**
 * 자동화 페이지 — 플레이북 목록·편집·실행.
 * 저장은 설정과 같은 방식으로 즉시 반영한다(저장 버튼은 편집 폼 안에만 있다)
 */
export function AutomationPage(): React.JSX.Element {
  const { t } = useTranslation()
  const items = usePlaybookStore((s) => s.items)
  const loading = usePlaybookStore((s) => s.loading)
  const error = usePlaybookStore((s) => s.error)
  const load = usePlaybookStore((s) => s.load)
  const save = usePlaybookStore((s) => s.save)
  const remove = usePlaybookStore((s) => s.remove)
  const restore = usePlaybookStore((s) => s.restore)
  const scheduleById = useScheduleStore((s) => s.byId)
  const loadSchedules = useScheduleStore((s) => s.load)
  const scheduleRunNow = useScheduleStore((s) => s.runNow)
  const setSchedulePaused = useScheduleStore((s) => s.setPaused)
  const modelChoices = useChatStore((s) => s.modelChoices)
  const loadModelMenu = useChatStore((s) => s.loadModelMenu)
  const [editing, setEditing] = useState<EditTarget>(null)

  useEffect(() => {
    void load()
    void loadSchedules()
    // 예약의 모델 칸은 설정의 작업별 모델 목록을 그대로 쓴다
    void loadModelMenu()
  }, [load, loadSchedules, loadModelMenu])
  // 메인이 예약 상태를 바꾸면(실행 시작·완료·자동 일시정지) 목록을 다시 읽는다
  useEffect(() => useScheduleStore.getState().subscribe(), [])

  const commit = (input: PlaybookInput): void => {
    void save(input).then((ok) => {
      if (ok) setEditing(null)
    })
  }

  // "지금 실행" — 브라우저 화면으로 돌아가 AI 패널을 열고, 첫 트리거 문구를 채팅에 넣는다
  const run = (phrase: string): void => {
    const ui = useUiStore.getState()
    ui.setView('browser')
    if (ui.panelCollapsed) ui.setPanelCollapsed(false)
    void useChatStore.getState().send(phrase)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-[var(--text)]">
              {t('automation.title')}
            </h1>
            <p className="mt-1 text-[11.5px] leading-snug text-[var(--text2)]">
              {t('automation.desc')}
            </p>
          </div>
          {editing !== 'new' && (
            <PrimaryButton onClick={() => setEditing('new')}>
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t('automation.action.new')}
              </span>
            </PrimaryButton>
          )}
        </header>

        {error !== '' && (
          <p className="rounded-[9px] border border-[#b91c1c] px-2.5 py-2 text-[11.5px] text-[#b91c1c]">
            {t('automation.saveFailed')}
          </p>
        )}

        {editing === 'new' && (
          <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text)]">
              {t('automation.action.new')}
            </h2>
            <div className="mt-3">
              <PlaybookEditor onSave={commit} onCancel={() => setEditing(null)} />
            </div>
          </section>
        )}

        {items.map((playbook) => (
          <PlaybookCard
            key={playbook.id}
            playbook={playbook}
            editing={editing === playbook.id}
            onEdit={() => setEditing(playbook.id)}
            onSave={commit}
            onCancel={() => setEditing(null)}
            onToggle={(enabled) =>
              void save({
                id: playbook.id,
                name: playbook.name,
                triggers: playbook.triggers,
                instructions: playbook.instructions,
                enabled
              })
            }
            onRun={() => run(runPhraseOf(playbook))}
            onRemove={() => void remove(playbook.id)}
            onRestore={() => void restore(playbook.id)}
            scheduleStatus={scheduleById[playbook.id]}
            modelChoices={modelChoices}
            onSchedule={(schedule: PlaybookSchedule) =>
              void save({
                id: playbook.id,
                name: playbook.name,
                triggers: playbook.triggers,
                instructions: playbook.instructions,
                enabled: playbook.enabled,
                schedule
              }).then(() => loadSchedules())
            }
            // 예약 경로로 실행한다 — 결과가 예약 기록(마지막 실행·이력)에 남는다
            onRunNow={() => void scheduleRunNow(playbook.id)}
            onSetPaused={(paused) => void setSchedulePaused(playbook.id, paused)}
          />
        ))}

        {!loading && items.length === 0 && (
          <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-3 text-center text-[11.5px] text-[var(--text2)]">
            {t('automation.empty')}
          </p>
        )}
      </div>
    </div>
  )
}
