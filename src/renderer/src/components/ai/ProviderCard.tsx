import type React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { AiProviderState } from '@shared/ai'
import { StatusBadge } from '@renderer/components/settings/shared'

interface Props {
  title: string
  description?: string
  state: AiProviderState
  /** 이 카드가 지금 고른 연결 경로인가 */
  selected: boolean
  /** 비활성 카드(서비스 크레딧)는 고를 수 없다 */
  disabled?: boolean
  onSelect?: () => void
  children?: React.ReactNode
}

// 상태 배지 문구 — i18n 키만 고른다(평문 문장을 코드에 두지 않는다)
const STATE_LABEL_KEYS: Record<AiProviderState, string> = {
  connected: 'settings.ai.connected',
  not_installed: 'settings.ai.notInstalled',
  needs_login: 'settings.ai.needsLogin',
  disabled: 'settings.ai.serviceCreditSoon',
  unset: 'settings.ai.unset'
}

/** AI 연결 경로 카드 한 장. 흰 카드 · 얇은 선 · 선택 시 검정 테두리 */
export function ProviderCard({
  title,
  description,
  state,
  selected,
  disabled,
  onSelect,
  children
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'rounded-2xl border bg-white p-4',
        selected && !disabled ? 'border-[var(--text)]' : 'border-[var(--line)]',
        disabled && 'opacity-60'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--text)]">{title}</div>
          {description && (
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text2)]">{description}</p>
          )}
        </div>
        <StatusBadge
          label={t(STATE_LABEL_KEYS[state])}
          tone={state === 'connected' ? 'strong' : state === 'not_installed' ? 'warn' : 'neutral'}
        />
      </div>

      {children && <div className="mt-3 flex flex-col gap-2.5">{children}</div>}

      {!disabled && (
        <button
          type="button"
          onClick={onSelect}
          disabled={selected}
          className={cn(
            'mt-3 h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] px-3 text-[12.5px] font-medium',
            selected
              ? 'border border-[var(--line)] text-[var(--text2)]'
              : 'bg-[var(--text)] text-white'
          )}
        >
          {selected ? t('settings.ai.inUse') : t('settings.ai.use')}
        </button>
      )}
    </div>
  )
}
