import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, MonitorOff, X } from 'lucide-react'
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
  const remove = usePhoneStore((s) => s.remove)
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
      {/* 머리글은 이름·모델만 보여 준다. 화면은 아래 '화면 보기' 버튼으로 연다 —
          모델명을 눌러야 열린다는 걸 알기 어려웠다(사용자 요청) */}
      <div className="group flex items-start gap-2">
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
        {/* 탭·대화의 X 처럼 확인 없이 바로 지운다. 다시 쓰려면 주소 연결이나 페어링을 하면 된다 */}
        <button
          type="button"
          aria-label={t('phone.remove')}
          title={t('phone.remove')}
          onClick={() => void remove(phone.id)}
          className="rounded-[7px] p-1 text-[var(--text3)] opacity-0 hover:bg-black/5 hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

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

      <div className="flex flex-wrap items-center gap-1.5">
        <SecondaryButton
          className="inline-flex h-[30px] items-center gap-1"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? (
            <MonitorOff className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Monitor className="h-3.5 w-3.5 shrink-0" />
          )}
          {t(expanded ? 'phone.hideScreen' : 'phone.showScreen')}
        </SecondaryButton>
        {canRecover(phone.state) && (
          <SecondaryButton className="h-[30px]" onClick={() => void recover(phone.serial)}>
            {t('phone.recover')}
          </SecondaryButton>
        )}
      </div>

      {expanded && <PhoneScreenView phone={phone} active={phone.state === 'online'} />}
    </section>
  )
}
