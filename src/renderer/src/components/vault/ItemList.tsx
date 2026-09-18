import { useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Plus, Download } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useVaultStore } from '@renderer/stores/vaultStore'
import type { AccountDto } from '@shared/ipc'

const GLOBAL_TYPES = new Set([
  'card',
  'passport',
  'id_card',
  'birth_date',
  'address',
  'phone',
  'custom'
])

function maskUsername(u: string): string {
  if (u.length <= 3) return `${u[0] ?? ''}••`
  return `${u.slice(0, 3)}…`
}

interface Props {
  onAdd: () => void
  onAddGlobal: () => void
  onImport: () => void
}

export function ItemList({ onAdd, onAddGlobal, onImport }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const accounts = useVaultStore((s) => s.accounts)
  const sites = useVaultStore((s) => s.sites)
  const itemsByAccount = useVaultStore((s) => s.itemsByAccount)
  const query = useVaultStore((s) => s.query)
  const setQuery = useVaultStore((s) => s.setQuery)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const selectedGlobalItemId = useVaultStore((s) => s.selectedGlobalItemId)
  const select = useVaultStore((s) => s.select)
  const selectGlobalItem = useVaultStore((s) => s.selectGlobalItem)
  const [chip, setChip] = useState<'all' | 'global'>('all')

  const globalItems = itemsByAccount.global ?? []

  const q = query.trim().toLowerCase()
  const matchAccount = (a: AccountDto): boolean => {
    if (!q) return true
    return (
      a.label.toLowerCase().includes(q) ||
      a.username.toLowerCase().includes(q) ||
      a.host.toLowerCase().includes(q)
    )
  }

  const grouped = useMemo(() => {
    const bySite = new Map<number, AccountDto[]>()
    for (const a of accounts) {
      if (!matchAccount(a)) continue
      const arr = bySite.get(a.siteId) ?? []
      arr.push(a)
      bySite.set(a.siteId, arr)
    }
    return sites
      .map((site) => ({ site, accounts: bySite.get(site.id) ?? [] }))
      .filter((g) => g.accounts.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, sites, q])

  const filteredGlobalItems = globalItems.filter((i) => !q || i.label.toLowerCase().includes(q))

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-r border-black/[.05]">
      <div className="flex flex-col gap-2.5 p-3.5 pb-2.5">
        <div className="flex h-8 items-center gap-2 rounded-[10px] bg-[var(--bg)] px-2.5 text-[var(--text3)]">
          <Search className="h-3.5 w-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('vault.list.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text3)]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setChip('all')}
            className={cn(
              'h-[26px] rounded-[8px] px-2.5 text-[12px] text-[var(--text2)]',
              chip === 'all' ? 'bg-[var(--text)] font-medium text-white' : 'bg-[var(--bg)]'
            )}
          >
            {t('vault.list.chipAll')}
          </button>
          <button
            type="button"
            onClick={() => setChip('global')}
            className={cn(
              'h-[26px] rounded-[8px] px-2.5 text-[12px] text-[var(--text2)]',
              chip === 'global' ? 'bg-[var(--text)] font-medium text-white' : 'bg-[var(--bg)]'
            )}
          >
            {t('vault.list.chipGlobal')}
          </button>
          <button
            type="button"
            onClick={onImport}
            title={t('vault.list.import')}
            className="ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[var(--line)] text-[var(--text2)]"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onAdd}
            title={t('vault.list.add')}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[var(--line)] text-[var(--text2)]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        {chip === 'all' &&
          grouped.map(({ site, accounts: siteAccounts }) => (
            <div key={site.id}>
              <div className="flex justify-between px-2 pb-1 pt-3 text-[11px] font-semibold text-[var(--text3)]">
                <span>{site.name}</span>
                <span>{siteAccounts.length}</span>
              </div>
              {siteAccounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => select(a.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left',
                    selectedAccountId === a.id && 'bg-[rgba(0,0,0,.06)]'
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--text)] text-[13px] font-bold text-white">
                    {site.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <b className="block truncate text-[13px] font-medium">{a.label}</b>
                    <span className="block truncate text-[11.5px] text-[var(--text3)]">
                      {maskUsername(a.username)}
                    </span>
                  </span>
                  {a.isDefault && (
                    <span className="ml-auto shrink-0 rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                      {t('vault.list.default')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        {(globalItems.length > 0 || !q) && (
          <div>
            <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[11px] font-semibold text-[var(--text3)]">
              <span>{t('vault.list.globalGroup')}</span>
              <span className="flex items-center gap-1.5">
                {filteredGlobalItems.length}
                <button
                  type="button"
                  onClick={onAddGlobal}
                  title={t('vault.list.addGlobal')}
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-[6px] border border-[var(--line)] text-[var(--text2)]"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </span>
            </div>
            {filteredGlobalItems
              .filter((i) => GLOBAL_TYPES.has(i.type))
              .map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => selectGlobalItem(i.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left',
                    selectedAccountId === 'global' &&
                      selectedGlobalItemId === i.id &&
                      'bg-[rgba(0,0,0,.06)]'
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--bg)] text-[13px] font-bold text-[var(--text2)]">
                    {i.label.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <b className="block truncate text-[13px] font-medium">{i.label}</b>
                    <span className="block truncate text-[11.5px] text-[var(--text3)]">
                      {t(`vault.itemType.${i.type}`)}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        )}
        {grouped.length === 0 && globalItems.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--text3)]">
            {t('vault.list.empty')}
          </p>
        )}
      </div>
    </div>
  )
}
