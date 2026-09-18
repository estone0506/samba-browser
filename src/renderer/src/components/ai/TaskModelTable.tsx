import type React from 'react'
import { useTranslation } from 'react-i18next'
import { TASK_MODEL_KEYS, type TaskModelKey, type TaskModels } from '@shared/ai'

interface Props {
  taskModels: TaskModels
  choices: string[]
  /** 제공자 전환으로 자동 대체된 등급(알림 띠에 쓴다) */
  changed: TaskModelKey[]
  onChange: (key: TaskModelKey, model: string) => void
  onDismissChanged: () => void
}

// 등급별 용도·쓰이는 곳 설명의 i18n 키
const ROW_KEYS: Record<TaskModelKey, { label: string; purpose: string; usedIn: string }> = {
  fast: {
    label: 'settings.ai.fast',
    purpose: 'ai.taskTable.fastPurpose',
    usedIn: 'ai.taskTable.fastUsedIn'
  },
  standard: {
    label: 'settings.ai.standard',
    purpose: 'ai.taskTable.standardPurpose',
    usedIn: 'ai.taskTable.standardUsedIn'
  },
  deep: {
    label: 'settings.ai.deep',
    purpose: 'ai.taskTable.deepPurpose',
    usedIn: 'ai.taskTable.deepUsedIn'
  },
  visual: {
    label: 'settings.ai.visual',
    purpose: 'ai.taskTable.visualPurpose',
    usedIn: 'ai.taskTable.visualUsedIn'
  }
}

/** 작업 등급 4행 × (용도 · 모델 선택 · 쓰이는 곳) */
export function TaskModelTable({
  taskModels,
  choices,
  changed,
  onChange,
  onDismissChanged
}: Props): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">
        {t('settings.ai.taskModels')}
      </h2>

      {changed.length > 0 && (
        <div className="mt-2 flex items-start justify-between gap-3 rounded-[9px] border border-[var(--line)] bg-black/[.03] px-2.5 py-2">
          <p className="text-[11.5px] leading-snug text-[var(--text)]">
            {t('ai.taskTable.remapped', {
              list: changed.map((k) => t(ROW_KEYS[k].label)).join(', ')
            })}
          </p>
          <button
            type="button"
            onClick={onDismissChanged}
            className="shrink-0 text-[11.5px] text-[var(--text2)] underline"
          >
            {t('ai.taskTable.dismiss')}
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-col">
        {TASK_MODEL_KEYS.map((key) => (
          <div
            key={key}
            className="flex flex-col gap-1.5 border-b border-[var(--line)] py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 sm:w-[34%]">
              <div className="text-[12.5px] font-medium text-[var(--text)]">
                {t(ROW_KEYS[key].label)}
              </div>
              <div className="text-[11px] leading-snug text-[var(--text2)]">
                {t(ROW_KEYS[key].purpose)}
              </div>
            </div>
            <div className="sm:w-[34%]">
              <input
                list={`task-model-choices-${key}`}
                value={taskModels[key]}
                onChange={(e) => onChange(key, e.target.value)}
                className="h-9 w-full rounded-[9px] border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[12.5px] text-[var(--text)] outline-none"
              />
              <datalist id={`task-model-choices-${key}`}>
                {choices.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="text-[11px] leading-snug text-[var(--text2)] sm:w-[32%]">
              {t(ROW_KEYS[key].usedIn)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
