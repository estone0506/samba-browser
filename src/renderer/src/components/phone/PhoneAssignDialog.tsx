import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'
import { usePhoneStore } from '@renderer/stores/phoneStore'
import { countryBadge } from './phone-view'

// 계정별 "담당 폰" 을 고르는 대화상자.
// 고르지 않으면(=없음) 인증 때 3대를 동시에 감시한다
export function PhoneAssignDialog({
  accountId,
  open,
  current,
  onOpenChange,
  onSaved
}: {
  accountId: number
  open: boolean
  /** 지금 저장돼 있는 담당 폰 id(없으면 null) — 열릴 때 이것부터 골라 둔다 */
  current: number | null
  onOpenChange: (open: boolean) => void
  onSaved: (phoneId: number | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { list, load, assign } = usePhoneStore()
  const [picked, setPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void load()
    // 열 때마다 저장된 선택에서 시작한다(항상 "고르지 않음"으로 열려 저장이 안 된 것처럼 보였다)
    setPicked(current)
  }, [open, load, current])

  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await assign(accountId, picked)
    setBusy(false)
    if (!ok) return
    onSaved(picked)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('phone.assign.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-[var(--text2)]">{t('phone.assign.desc')}</p>
        <div className="flex flex-col gap-1.5">
          <PickRow
            label={t('phone.assign.none')}
            description={t('phone.assign.noneDesc')}
            selected={picked === null}
            onClick={() => setPicked(null)}
          />
          {list.map((phone) => (
            <PickRow
              key={phone.id}
              label={`${phone.label || phone.serial} · ${countryBadge(phone.country)}`}
              description={phone.model || phone.serial}
              selected={picked === phone.id}
              onClick={() => setPicked(phone.id)}
            />
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={() => onOpenChange(false)}>
            {t('phone.assign.cancel')}
          </SecondaryButton>
          <PrimaryButton disabled={busy} onClick={() => void save()}>
            {t('phone.assign.save')}
          </PrimaryButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PickRow({
  label,
  description,
  selected,
  onClick
}: {
  label: string
  description: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-[10px] border px-3 py-2 text-left',
        selected ? 'border-[var(--text)] bg-black/[.04]' : 'border-[var(--line)]'
      )}
    >
      <span className="block text-[12.5px] font-medium text-[var(--text)]">{label}</span>
      <span className="block text-[11px] text-[var(--text2)]">{description}</span>
    </button>
  )
}

// 인증에 성공한 폰을 그 계정의 담당 폰으로 제안하는 배너.
// 담당 폰을 고르지 않은 채 작업이 돌아간 뒤에만 뜬다
export function PhoneAssignSuggestion({ accountId }: { accountId: number }): React.JSX.Element {
  const { t } = useTranslation()
  const suggestion = usePhoneStore((s) => s.assignSuggestion)
  const list = usePhoneStore((s) => s.list)
  const assign = usePhoneStore((s) => s.assign)
  const clear = usePhoneStore((s) => s.clearAssignSuggestion)
  if (!suggestion) return <></>
  const phone = list.find((p) => p.id === suggestion.phoneId)
  if (!phone) return <></>
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-3 py-2">
      <span className="min-w-0 flex-1 text-[12px] text-[var(--text2)]">
        {t('phone.assign.suggestion', {
          phone: phone.label || phone.serial,
          host: suggestion.siteHost
        })}
      </span>
      <SecondaryButton
        className="h-[28px]"
        onClick={() => void assign(accountId, suggestion.phoneId)}
      >
        {t('phone.assign.accept')}
      </SecondaryButton>
      <SecondaryButton className="h-[28px]" onClick={clear}>
        {t('phone.assign.dismiss')}
      </SecondaryButton>
    </div>
  )
}
