import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Pause, Play } from 'lucide-react'
import {
  SCHEDULE_INTERVALS,
  SCHEDULE_KINDS,
  SCHEDULE_PERMISSION_MODES,
  normalizeSchedule,
  scheduleOf,
  type PlaybookSchedule,
  type ScheduleStatusDto
} from '@shared/schedule'
import { Switch } from '@renderer/components/ui/switch'
import { SecondaryButton, SegmentedGroup, StatusBadge } from '@renderer/components/settings/shared'
import {
  formatClock,
  historyMarks,
  kindLabelKey,
  pauseReasonKey,
  relativeTime,
  resultLabelKey,
  rulePhrase,
  stateLabelKey,
  weekdayLabelKey,
  withKind
} from './schedule-view'
import { useNow } from '@renderer/lib/use-now'

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

/**
 * 플레이북 카드 안의 "예약" 칸.
 *
 * 표를 늘어놓는 대신 **한 줄 요약 문장**("매일 09:00 · 다음 실행 2시간 후 · 마지막 성공 …")
 * 과 최근 10회 점(●○)만 먼저 보여 주고, 세부 설정은 접어 둔다.
 * 실행 이력 상세는 나중에 '작업' 페이지가 맡으므로 여기서는 최근 10회까지만 다룬다
 */
export function ScheduleCard({
  schedule: raw,
  status,
  modelChoices,
  onChange,
  onRunNow,
  onSetPaused
}: {
  schedule: PlaybookSchedule | undefined
  status?: ScheduleStatusDto
  /** 설정의 작업별 모델 목록. 비워 두면 "전역 설정 따름" */
  modelChoices: string[]
  onChange: (schedule: PlaybookSchedule) => void
  onRunNow: () => void
  onSetPaused: (paused: boolean) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const schedule = normalizeSchedule(scheduleOf(raw))
  const state = status?.state ?? (schedule.paused ? 'paused' : schedule.enabled ? 'waiting' : 'off')
  const now = useNow()
  const weekdayNames = (schedule.weekdays ?? []).map((d) => t(weekdayLabelKey(d)))
  const rule = rulePhrase(schedule, weekdayNames)
  const marks = historyMarks(status?.history ?? [])

  // "매일 09:00 · 다음 실행 2시간 후 · 마지막 성공 20시간 전" 을 한 줄로 잇는다.
  // 없는 조각은 그냥 빠진다 — 빈 칸에 '—' 를 채워 넣지 않는다
  const parts: string[] = [t(rule.key, rule.params)]
  if (status?.nextRunAt != null) {
    const rel = relativeTime(status.nextRunAt, now)
    parts.push(t('schedule.next', { when: t(rel.key, rel.params) }))
  }
  if (status?.lastRunAt != null && status.lastResult !== null) {
    const rel = relativeTime(status.lastRunAt, now)
    parts.push(
      t('schedule.last', {
        result: t(resultLabelKey(status.lastResult)),
        when: t(rel.key, rel.params)
      })
    )
  }

  const patch = (next: Partial<PlaybookSchedule>): void =>
    onChange(normalizeSchedule({ ...schedule, ...next }))

  const toggleWeekday = (day: number): void => {
    const current = schedule.weekdays ?? []
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day]
    // 전부 끄면 예약이 영영 돌지 않는다 — 마지막 하나는 끄지 못하게 한다
    if (next.length === 0) return
    patch({ weekdays: next })
  }

  return (
    <div className="mt-3 rounded-[12px] border border-[var(--line)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] font-medium text-[var(--text)]"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          {t('schedule.title')}
        </button>
        <StatusBadge
          label={
            status?.pauseReason === undefined
              ? t(stateLabelKey(state))
              : `${t(stateLabelKey(state))} · ${t(pauseReasonKey(status.pauseReason))}`
          }
          tone={state === 'running' ? 'strong' : state === 'paused' ? 'warn' : 'neutral'}
        />
        {schedule.kind !== 'manual' && (
          <Switch
            checked={schedule.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
            aria-label={t('schedule.action.toggle')}
          />
        )}
      </div>

      <p className="mt-2 text-[11.5px] leading-snug text-[var(--text2)]">{parts.join(' · ')}</p>

      {status?.lastSummary !== undefined && status.lastSummary !== '' && (
        <p
          className="mt-1 truncate text-[11.5px] leading-snug text-[var(--text2)]"
          title={status.lastSummary}
        >
          {status.lastRunAt === null
            ? status.lastSummary
            : `${formatClock(status.lastRunAt, i18n.language)} — ${status.lastSummary}`}
        </p>
      )}

      {marks.length > 0 && (
        <div className="mt-1.5 flex items-center gap-[3px] text-[10px] leading-none text-[var(--text2)]">
          {marks.map((mark) => (
            <span
              key={mark.at}
              title={`${formatClock(mark.at, i18n.language)} · ${t(resultLabelKey(mark.result))}`}
            >
              {mark.glyph}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        <SecondaryButton onClick={onRunNow} disabled={state === 'running'}>
          <span className="flex items-center gap-1.5">
            <Play className="h-3 w-3 fill-current" />
            {t('schedule.action.runNow')}
          </span>
        </SecondaryButton>
        {schedule.kind !== 'manual' && schedule.enabled && (
          <SecondaryButton onClick={() => onSetPaused(!schedule.paused)}>
            <span className="flex items-center gap-1.5">
              {schedule.paused ? (
                <Play className="h-3 w-3 fill-current" />
              ) : (
                <Pause className="h-3 w-3 fill-current" />
              )}
              {t(schedule.paused ? 'schedule.action.resume' : 'schedule.action.pause')}
            </span>
          </SecondaryButton>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-[var(--line)] pt-3">
          <Field label={t('schedule.field.kind')}>
            <SegmentedGroup
              value={schedule.kind}
              options={SCHEDULE_KINDS.map((kind) => ({
                value: kind,
                label: t(kindLabelKey(kind))
              }))}
              onChange={(kind) => onChange(normalizeSchedule(withKind(schedule, kind)))}
            />
          </Field>

          {schedule.kind === 'interval' && (
            <Field label={t('schedule.field.interval')}>
              <SegmentedGroup
                value={String(schedule.everyMinutes ?? 60)}
                options={SCHEDULE_INTERVALS.map((minutes) => ({
                  value: String(minutes),
                  label:
                    minutes % 60 === 0
                      ? t('schedule.rule.everyHours', { hours: minutes / 60 })
                      : t('schedule.rule.everyMinutes', { minutes })
                }))}
                onChange={(v) => patch({ everyMinutes: Number(v) })}
              />
            </Field>
          )}

          {(schedule.kind === 'daily' || schedule.kind === 'weekly') && (
            <Field label={t('schedule.field.at')}>
              <input
                type="time"
                value={schedule.at ?? '09:00'}
                onChange={(e) => patch({ at: e.target.value })}
                className="h-9 w-[128px] rounded-[9px] border border-[var(--line)] bg-white px-2.5 text-[13px] text-[var(--text)] outline-none"
              />
            </Field>
          )}

          {schedule.kind === 'weekly' && (
            <Field label={t('schedule.field.weekdays')}>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day) => {
                  const on = (schedule.weekdays ?? []).includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleWeekday(day)}
                      className={
                        on
                          ? 'h-[28px] w-[34px] rounded-[8px] border border-[var(--text)] bg-[var(--text)] text-[12px] font-medium text-white'
                          : 'h-[28px] w-[34px] rounded-[8px] border border-[var(--line)] text-[12px] text-[var(--text2)]'
                      }
                    >
                      {t(weekdayLabelKey(day))}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          <Field label={t('schedule.field.model')} description={t('schedule.inheritDesc')}>
            <select
              value={schedule.model ?? ''}
              onChange={(e) => patch({ model: e.target.value === '' ? undefined : e.target.value })}
              className="h-9 w-full rounded-[9px] border border-[var(--line)] bg-white px-2.5 text-[12.5px] text-[var(--text)] outline-none"
            >
              <option value="">{t('schedule.inherit')}</option>
              {modelChoices.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('schedule.field.permission')}>
            <SegmentedGroup
              value={schedule.permissionMode ?? ''}
              options={[
                { value: '', label: t('schedule.inherit') },
                ...SCHEDULE_PERMISSION_MODES.map((mode) => ({
                  value: mode,
                  label: t(`schedule.permission.${mode}`)
                }))
              ]}
              onChange={(v) =>
                patch({
                  permissionMode:
                    v === '' ? undefined : (v as (typeof SCHEDULE_PERMISSION_MODES)[number])
                })
              }
            />
          </Field>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-[12px] font-medium text-[var(--text)]">{label}</div>
        {description !== undefined && (
          <div className="text-[11px] leading-snug text-[var(--text2)]">{description}</div>
        )}
      </div>
      {children}
    </div>
  )
}
