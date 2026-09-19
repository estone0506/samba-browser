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
  /** 표시용 계정(이메일). 토큰·키가 아니다 */
  account?: string
  /** 구독 카드에서 연결/해지 버튼을 보일지 */
  connectable?: boolean
  /** 연결/해지 요청이 도는 중 */
  busy?: boolean
  onSelect?: () => void
  onConnect?: () => void
  onDisconnect?: () => void
  children?: React.ReactNode
}

// 상태 배지 문구 — i18n 키만 고른다(평문 문장을 코드에 두지 않는다)
const STATE_LABEL_KEYS: Record<AiProviderState, string> = {
  connected: 'settings.ai.connected',
  available: 'settings.ai.available',
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
  account,
  connectable,
  busy,
  onSelect,
  onConnect,
  onDisconnect,
  children
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  // 연결된 경로만 실제로 쓸 수 있다 — 미연결 구독 카드는 '이 경로 쓰기' 를 막는다
  const usable = !connectable || state === 'connected'
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
          {account && (
            <p className="mt-1 truncate font-mono text-[11.5px] text-[var(--text2)]">{account}</p>
          )}
        </div>
        <StatusBadge
          label={t(STATE_LABEL_KEYS[state])}
          tone={state === 'connected' ? 'strong' : state === 'not_installed' ? 'warn' : 'neutral'}
        />
      </div>

      {children && <div className="mt-3 flex flex-col gap-2.5">{children}</div>}

      {!disabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {connectable && state !== 'connected' && (
            <button
              type="button"
              onClick={onConnect}
              disabled={busy}
              className="h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] bg-[var(--text)] px-3 text-[12.5px] font-medium text-white disabled:opacity-50"
            >
              {t('settings.ai.connect')}
            </button>
          )}
          {connectable && state === 'connected' && (
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy}
              className="h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text2)] disabled:opacity-50"
            >
              {t('settings.ai.disconnect')}
            </button>
          )}
          <button
            type="button"
            onClick={onSelect}
            disabled={selected || !usable}
            className={cn(
              'h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] px-3 text-[12.5px] font-medium disabled:opacity-50',
              selected
                ? 'border border-[var(--line)] text-[var(--text2)]'
                : 'bg-[var(--text)] text-white'
            )}
          >
            {selected ? t('settings.ai.inUse') : t('settings.ai.use')}
          </button>
        </div>
      )}
    </div>
  )
}
