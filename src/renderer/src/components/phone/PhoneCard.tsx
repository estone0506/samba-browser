import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PhoneDto, ScreenMode } from '@shared/phone'
import { cn } from '@renderer/lib/utils'
import { SecondaryButton, StatusBadge } from '@renderer/components/settings/shared'
import { usePhoneStore } from '@renderer/stores/phoneStore'
import { PhoneScreenView } from './PhoneScreenView'
import {
  canRecover,
  countryBadge,
  isPhoneDimmed,
  phoneStateDotClass,
  phoneStateLabelKey,
  phoneStateTone,
  screenBadgeKey,
  transportLabelKey
} from './phone-view'

// 폰 카드 한 장. 접혀 있으면 요약만, 펼치면 화면과 수동 조작 패드까지 보여 준다.
// 인증 대기 중인 폰은 자동으로 펼쳐지고 테두리가 강조된다
export function PhoneCard({
  phone,
  expanded,
  highlighted,
  screenMode,
  onToggle
}: {
  phone: PhoneDto
  expanded: boolean
  highlighted: boolean
  screenMode: ScreenMode | null
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const recover = usePhoneStore((s) => s.recover)
  const dimmed = isPhoneDimmed(phone.state)
  const badge = screenBadgeKey(screenMode ?? phone.screenMode)

  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-white p-4',
        dimmed && 'opacity-50',
        highlighted && 'ring-2 ring-black/70'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex items-start gap-2 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text2)]" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text2)]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('h-[7px] w-[7px] rounded-full', phoneStateDotClass(phone.state))} />
            <span className="truncate text-[13px] font-semibold text-[var(--text)]">
              {phone.label || phone.serial}
            </span>
            <StatusBadge label={countryBadge(phone.country)} />
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text2)]">
            {phone.model || phone.serial}
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge
          label={t(phoneStateLabelKey(phone.state))}
          tone={phoneStateTone(phone.state)}
        />
        <StatusBadge label={t(transportLabelKey(phone.transport))} />
        {badge && <StatusBadge label={t(badge)} />}
      </div>

      {highlighted && (
        <p className="rounded-[9px] border border-dashed border-[var(--text)] px-2.5 py-2 text-[11.5px] text-[var(--text)]">
          {t('phone.authWaiting')}
        </p>
      )}

      {canRecover(phone.state) && (
        <SecondaryButton className="h-[30px]" onClick={() => void recover(phone.serial)}>
          {t('phone.recover')}
        </SecondaryButton>
      )}

      {expanded && <PhoneScreenView phone={phone} active={phone.state === 'online'} />}
    </section>
  )
}
