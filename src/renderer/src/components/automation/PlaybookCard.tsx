import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import type { PlaybookDto, PlaybookInput } from '@shared/playbook'
import type { PlaybookSchedule, ScheduleStatusDto } from '@shared/schedule'
import { Switch } from '@renderer/components/ui/switch'
import { PrimaryButton, SecondaryButton, StatusBadge } from '@renderer/components/settings/shared'
import { PlaybookEditor } from './PlaybookEditor'
import { ScheduleCard } from './ScheduleCard'
import { previewOf } from './playbook-view'

/**
 * 플레이북 카드 한 장. 편집 중이면 카드 자리에 편집 폼이 들어선다.
 * 내장 플레이북은 삭제 대신 '기본값 복원' 을 보여 준다
 */
export function PlaybookCard({
  playbook,
  editing,
  onEdit,
  onSave,
  onCancel,
  onToggle,
  onRun,
  onRemove,
  onRestore,
  scheduleStatus,
  modelChoices,
  onSchedule,
  onRunNow,
  onSetPaused
}: {
  playbook: PlaybookDto
  editing: boolean
  onEdit: () => void
  onSave: (input: PlaybookInput) => void
  onCancel: () => void
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onRemove: () => void
  onRestore: () => void
  scheduleStatus?: ScheduleStatusDto
  modelChoices: string[]
  onSchedule: (schedule: PlaybookSchedule) => void
  /** 예약 경로로 실행한다(결과가 예약 기록에 남는다) */
  onRunNow: () => void
  onSetPaused: (paused: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const preview = previewOf(playbook.instructions)
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
          {playbook.name}
        </h2>
        {playbook.builtin === true && <StatusBadge label={t('automation.builtin')} />}
        {!playbook.enabled && <StatusBadge label={t('automation.off')} tone="warn" />}
        <Switch
          checked={playbook.enabled}
          onCheckedChange={onToggle}
          aria-label={t('automation.action.toggle')}
        />
      </div>

      {editing ? (
        <div className="mt-3">
          <PlaybookEditor playbook={playbook} onSave={onSave} onCancel={onCancel} />
        </div>
      ) : (
        <>
          {playbook.triggers.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {playbook.triggers.map((trigger) => (
                <li
                  key={trigger}
                  className="rounded-full border border-[var(--line)] px-2.5 py-0.5 text-[11.5px] text-[var(--text2)]"
                >
                  {trigger}
                </li>
              ))}
            </ul>
          )}
          {preview !== '' && (
            <p className="mt-2.5 text-[11.5px] leading-snug text-[var(--text2)]">{preview}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton onClick={onRun} disabled={!playbook.enabled}>
              <span className="flex items-center gap-1.5">
                <Play className="h-3 w-3 fill-current" />
                {t('automation.action.run')}
              </span>
            </PrimaryButton>
            <SecondaryButton onClick={onEdit}>{t('automation.action.edit')}</SecondaryButton>
            {playbook.builtin === true ? (
              <SecondaryButton onClick={onRestore}>
                {t('automation.action.restore')}
              </SecondaryButton>
            ) : (
              <SecondaryButton onClick={onRemove}>{t('automation.action.delete')}</SecondaryButton>
            )}
          </div>
          <ScheduleCard
            schedule={playbook.schedule}
            status={scheduleStatus}
            modelChoices={modelChoices}
            onChange={onSchedule}
            onRunNow={onRunNow}
            onSetPaused={onSetPaused}
          />
        </>
      )}
    </section>
  )
}
