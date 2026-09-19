import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { SiteFavicon } from '@renderer/components/vault/SiteFavicon'
import { tabFaviconHost, tabRowLabel } from './sidebar-view'

/**
 * 사이드바의 "열린 탭" 섹션. 위쪽 TabBar 와 같은 목록(browserStore)을 세로로 보여 준다.
 * 클릭하면 그 탭으로 전환하고 브라우저 뷰로 돌아오며, 호버 시 × 로 닫는다
 */
export function OpenTabs(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useBrowserStore((s) => s.tabs)
  const activateTab = useBrowserStore((s) => s.activateTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const setView = useUiStore((s) => s.setView)

  if (tabs.length === 0)
    return <div className="px-2 py-1 text-[11px] text-[var(--text3)]">{t('tab.empty')}</div>

  return (
    <ul className="flex flex-col">
      {tabs.map((tab) => {
        const label = tabRowLabel(tab, t('tab.untitled'))
        const host = tabFaviconHost(tab.url)
        return (
          <li key={tab.id} className="group relative flex items-center">
            <button
              type="button"
              title={label}
              onClick={() => {
                void activateTab(tab.id)
                setView('browser')
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5',
                tab.active && 'bg-black/5 font-medium text-[var(--text)]'
              )}
            >
              {host ? (
                <SiteFavicon host={host} size={14} />
              ) : (
                <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
              )}
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={t('tab.close')}
              title={t('tab.close')}
              onClick={() => void closeTab(tab.id)}
              className="absolute right-1 hidden rounded-[7px] p-1 text-[var(--text3)] hover:bg-black/5 hover:text-[var(--text)] group-hover:block"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
