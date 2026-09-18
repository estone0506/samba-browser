import type React from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus } from 'lucide-react'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

export function TabBar(): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, activateTab, closeTab, createTab } = useBrowserStore()
  return (
    <div
      className="flex items-end gap-1 px-2.5 pt-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => activateTab(tab.id)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={cn(
            'flex max-w-[200px] items-center gap-2 rounded-t-lg px-2.5 pb-2 pt-1.5 text-[12.5px] text-[var(--text2)] cursor-default',
            tab.active && 'bg-[var(--bg)] font-medium text-[var(--text)]'
          )}
        >
          <span className="truncate">{tab.title || tab.url}</span>
          {tab.profile !== 'default' && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10.5px]">
              {tab.profile}
            </Badge>
          )}
          <X
            className="h-3.5 w-3.5 shrink-0 text-[var(--text3)] hover:text-[var(--text)]"
            onClick={(e) => {
              e.stopPropagation()
              void closeTab(tab.id)
            }}
          />
        </div>
      ))}
      <button
        title={t('tab.new')}
        onClick={() => createTab()}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="px-2 pb-2 pt-1.5 text-[var(--text3)]"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}
