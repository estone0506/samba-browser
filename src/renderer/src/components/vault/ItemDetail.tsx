import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@renderer/stores/uiStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { Button } from '@renderer/components/ui/button'
import type { AuditLogDto, VaultItemMeta } from '@shared/ipc'

const USAGE_HISTORY_LIMIT = 10
// '보기' 로 화면에 드러낸 값을 자동으로 다시 가리는 시간(ms)
const REVEAL_AUTO_HIDE_MS = 30_000
// 값을 클립보드에 복사한 뒤 이 시간(ms)이 지나면, 복사 당시와 값이 같을 때만 비운다
const CLIPBOARD_CLEAR_MS = 30_000

// 클립보드에 값을 복사하고, 일정 시간 뒤에도 여전히 같은 값이면 비운다.
// readText 가 실패하면(권한 거부 등) 아무 것도 하지 않는다 — 그 사이 사용자가 복사한
// 다른 내용을 우리가 지워버리는 편이 더 나쁜 결과다
async function copyWithAutoClear(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
  setTimeout(() => {
    void navigator.clipboard
      .readText()
      .then((current) => {
        if (current === value) return navigator.clipboard.writeText('')
        return undefined
      })
      .catch(() => {
        // no-op
      })
  }, CLIPBOARD_CLEAR_MS)
}

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

  // 드러낸 값은 30초 뒤 자동으로 다시 가린다(자리를 비운 사이 화면에 남지 않게)
  useEffect(() => {
    if (value === null) return
    const timer = setTimeout(() => setValue(null), REVEAL_AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [value])

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
    if (v) void copyWithAutoClear(v)
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
          title={t('vault.detail.copyClearHint')}
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
            title={t('vault.detail.copyClearHint')}
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
  // 전역(계정 없는) 항목 편집. 계정용 onEdit 과 분리해 항상 대상 항목을 명시적으로 넘긴다
  onEditGlobal: (item: VaultItemMeta) => void
}

export function ItemDetail({ onEdit, onEditGlobal }: Props): React.JSX.Element {
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
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] rounded-[9px]"
              onClick={() => onEditGlobal(item)}
            >
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
        <UsageSection key={`global-${item.id}`} itemId={item.id} />
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
            onCopy={() => void copyWithAutoClear(account.username)}
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

      <UsageSection key={`account-${account.id}`} accountId={account.id} />
    </div>
  )
}

// 사용 기록(감사 로그) 최근 10건. accountId 를 주면 그 계정 소유 항목, itemId 를 주면
// 전역 항목 하나(계정이 없어 accountId 로 걸러낼 수 없다)의 기록만 보여준다
function UsageSection({
  accountId,
  itemId
}: {
  accountId?: number
  itemId?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<AuditLogDto[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.samba.vault.audit(accountId).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setLogs([])
        return
      }
      const rows = itemId !== undefined ? r.data.filter((l) => l.itemId === itemId) : r.data
      setLogs(rows.slice(0, USAGE_HISTORY_LIMIT))
    })
    return () => {
      cancelled = true
    }
  }, [accountId, itemId])

  return (
    <section className="mb-5">
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
        {t('vault.detail.history')}
      </h4>
      {!logs || logs.length === 0 ? (
        <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-4 text-center text-[12.5px] text-[var(--text3)]">
          {t('vault.detail.noHistory')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          {logs.map((log) => (
            <div
              key={log.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0"
            >
              <span className="text-[12.5px] text-[var(--text2)]">
                {new Date(log.at).toLocaleString()}
              </span>
              <span className="text-[12.5px]">{t(`vault.detail.auditAction.${log.action}`)}</span>
              <span className="rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                {t(`vault.detail.auditSource.${log.source}`)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
