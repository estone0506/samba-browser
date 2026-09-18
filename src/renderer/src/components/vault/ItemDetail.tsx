import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@renderer/stores/uiStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { Button } from '@renderer/components/ui/button'
import type { VaultItemMeta } from '@shared/ipc'

const PERSONAL_TYPES = new Set([
  'card',
  'passport',
  'id_card',
  'birth_date',
  'address',
  'phone',
  'custom'
])

// 비밀값 한 줄. '보기'를 누른 동안만 화면에 표시하고, 토글을 끄거나
// 컴포넌트가 사라지면(계정 전환·잠금 포함) 즉시 지운다
function RevealRow({
  label,
  item,
  danger
}: {
  label: string
  item: VaultItemMeta
  danger?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const reveal = useVaultStore((s) => s.reveal)
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => () => setValue(null), [item.id])

  const toggle = async (): Promise<void> => {
    if (value !== null) {
      setValue(null)
      return
    }
    setBusy(true)
    const v = await reveal(item.id)
    setBusy(false)
    setValue(v)
  }

  const copy = async (): Promise<void> => {
    const v = value ?? (await reveal(item.id))
    if (v) void navigator.clipboard.writeText(v)
  }

  return (
    <div className="grid grid-cols-[150px_1fr_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0">
      <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text2)]">
        {label}
        {danger && (
          <span className="rounded-full bg-[rgba(255,59,48,.12)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#ff3b30]">
            {t('vault.detail.dangerBadge')}
          </span>
        )}
      </span>
      <span className="truncate font-mono text-[13px] tracking-[2px] text-[var(--text2)]">
        {value ?? '••••••••••••'}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
        >
          {value !== null ? t('vault.detail.hide') : t('vault.detail.show')}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
        >
          {t('vault.detail.copy')}
        </button>
      </div>
    </div>
  )
}

function PlainRow({
  label,
  value,
  onCopy,
  onOpen
}: {
  label: string
  value: string
  onCopy?: () => void
  onOpen?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-[150px_1fr_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0">
      <span className="text-[12.5px] text-[var(--text2)]">{label}</span>
      <span className="truncate text-[13px]">{value}</span>
      <div className="flex gap-1">
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
          >
            {t('vault.detail.copy')}
          </button>
        )}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
          >
            {t('vault.detail.open')}
          </button>
        )}
      </div>
    </div>
  )
}

interface Props {
  onEdit: () => void
}

export function ItemDetail({ onEdit }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const accounts = useVaultStore((s) => s.accounts)
  const sites = useVaultStore((s) => s.sites)
  const itemsByAccount = useVaultStore((s) => s.itemsByAccount)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const selectedGlobalItemId = useVaultStore((s) => s.selectedGlobalItemId)

  const lock = useVaultStore((s) => s.lock)

  const openInBrowser = (host: string): void => {
    void window.samba.tabs.create({ url: `https://${host}` })
    setView('browser')
  }

  if (selectedAccountId === 'global') {
    const item = (itemsByAccount.global ?? []).find((i) => i.id === selectedGlobalItemId)
    if (!item) {
      return (
        <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text3)]">
          {t('vault.detail.empty')}
        </div>
      )
    }
    return (
      <div className="flex-1 overflow-auto px-9 py-7">
        <div className="mb-6 flex items-center gap-3.5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-[22px] font-extrabold text-white">
            {item.label.slice(0, 1)}
          </div>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">{item.label}</h1>
            <div className="mt-0.5 text-[12.5px] text-[var(--text2)]">
              {t(`vault.itemType.${item.type}`)}
            </div>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button variant="outline" size="sm" className="h-[30px] rounded-[9px]" onClick={onEdit}>
              {t('vault.detail.edit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] rounded-[9px]"
              onClick={() => void lock()}
            >
              {t('vault.detail.lock')}
            </Button>
          </div>
        </div>
        <section className="mb-5">
          <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
            {t('vault.detail.value')}
          </h4>
          <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            <RevealRow label={t('vault.detail.value')} item={item} />
          </div>
        </section>
        <UsageSection />
      </div>
    )
  }

  const account = accounts.find((a) => a.id === selectedAccountId)
  if (!account) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text3)]">
        {t('vault.detail.empty')}
      </div>
    )
  }
  const site = sites.find((s) => s.id === account.siteId)
  const items = itemsByAccount[String(account.id)] ?? []
  const loginItem = items.find((i) => i.type === 'login_password')
  const paymentItem = items.find((i) => i.type === 'payment_password')
  const personalItems = items.filter((i) => PERSONAL_TYPES.has(i.type))

  return (
    <div className="flex-1 overflow-auto px-9 py-7">
      <div className="mb-6 flex items-center gap-3.5">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-[22px] font-extrabold text-white">
          {(site?.name ?? account.host).slice(0, 1)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold tracking-tight">
            {site?.name ?? account.host} · {account.label}
          </h1>
          <div className="mt-0.5 truncate text-[12.5px] text-[var(--text2)]">{account.host}</div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={() => openInBrowser(account.host)}
          >
            {t('vault.detail.openInBrowser')}
          </Button>
          <Button variant="outline" size="sm" className="h-[30px] rounded-[9px]" onClick={onEdit}>
            {t('vault.detail.edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={() => void lock()}
          >
            {t('vault.detail.lock')}
          </Button>
        </div>
      </div>

      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.detail.login')}
        </h4>
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          <PlainRow
            label={t('vault.detail.username')}
            value={account.username}
            onCopy={() => void navigator.clipboard.writeText(account.username)}
          />
          {loginItem && <RevealRow label={t('vault.detail.password')} item={loginItem} />}
          {site?.loginUrl && (
            <PlainRow
              label={t('vault.detail.loginUrl')}
              value={site.loginUrl}
              onOpen={() => openInBrowser(account.host)}
            />
          )}
        </div>
      </section>

      {paymentItem && (
        <section className="mb-5">
          <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
            {t('vault.detail.payment')}
          </h4>
          <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            <RevealRow label={t('vault.detail.paymentPassword')} item={paymentItem} danger />
          </div>
        </section>
      )}

      {personalItems.length > 0 && (
        <section className="mb-5">
          <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
            {t('vault.detail.personal')}
          </h4>
          <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            {personalItems.map((i) => (
              <RevealRow key={i.id} label={i.label} item={i} />
            ))}
          </div>
        </section>
      )}

      <UsageSection />
    </div>
  )
}

function UsageSection(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="mb-5">
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
        {t('vault.detail.history')}
      </h4>
      <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-4 text-center text-[12.5px] text-[var(--text3)]">
        {t('vault.detail.noHistory')}
      </div>
    </section>
  )
}
