import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ListChecks, Repeat, KeyRound, Smartphone, ScrollText, Settings } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const ITEMS = [
  { key: 'browser', icon: Globe },
  { key: 'tasks', icon: ListChecks },
  { key: 'automation', icon: Repeat },
  { key: 'accounts', icon: KeyRound },
  { key: 'phones', icon: Smartphone },
  { key: 'logs', icon: ScrollText }
] as const

export function Sidebar({ width }: { width: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-[var(--line)] bg-[#f6f6f8]/90 p-2.5 pt-10 backdrop-blur"
    >
      <div className="flex items-center gap-2 px-2 pb-3 text-[14px] font-semibold">
        <span className="h-[22px] w-[22px] rounded-[7px] bg-[var(--text)]" />
        {t('app.name')}
      </div>
      {ITEMS.map(({ key, icon: Icon }) => (
        <div
          key={key}
          className={cn(
            'flex items-center gap-2 rounded-[9px] px-2 py-1.5',
            key === 'browser' && 'bg-black/5 font-medium'
          )}
        >
          <Icon className="h-4 w-4 text-[var(--text2)]" />
          {t(`sidebar.${key}`)}
        </div>
      ))}
      <div className="px-2 pb-1.5 pt-3 text-[11px] font-semibold text-[var(--text3)]">
        {t('sidebar.chats')}
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-black/5 px-2 pt-2 text-[var(--text2)]">
        <Settings className="h-4 w-4" />
        {t('sidebar.settings')}
      </div>
    </aside>
  )
}
