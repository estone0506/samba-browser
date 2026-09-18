import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ListChecks, Repeat, KeyRound, Smartphone, ScrollText, Settings } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import logo from '@renderer/assets/logo.png'
import { useUiStore, type MainView } from '@renderer/stores/uiStore'
import { BookmarkTree } from './BookmarkTree'
import { WorkspaceSwitcher } from '@renderer/components/workspace/WorkspaceSwitcher'

// 사이드바 항목 중 아직 뷰가 없는 항목(작업·자동화·폰·로그)은 클릭해도 아무 일도 하지 않는다
const ITEMS = [
  { key: 'browser', icon: Globe, view: 'browser' },
  { key: 'tasks', icon: ListChecks, view: null },
  { key: 'automation', icon: Repeat, view: null },
  { key: 'accounts', icon: KeyRound, view: 'personal' },
  { key: 'phones', icon: Smartphone, view: null },
  { key: 'logs', icon: ScrollText, view: null }
] as const satisfies readonly { key: string; icon: typeof Globe; view: MainView | null }[]

export function Sidebar({ width }: { width: number }): React.JSX.Element {
  const { t } = useTranslation()
  const { view, setView } = useUiStore()
  return (
    <aside
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col border-r border-[var(--line)] bg-[#f6f6f8]/90 p-2.5 pt-10 backdrop-blur"
    >
      <div className="flex items-center gap-2 px-2 pb-3 text-[14px] font-semibold">
        <img src={logo} alt="" className="h-[22px] w-[22px] rounded-[7px]" />
        {t('app.name')}
      </div>
      {/* 작업공간 전환기 (신규 추가분) */}
      <WorkspaceSwitcher />
      {ITEMS.map(({ key, icon: Icon, view: itemView }) => (
        <button
          key={key}
          type="button"
          onClick={() => itemView && setView(itemView)}
          className={cn(
            'flex items-center gap-2 rounded-[9px] px-2 py-1.5 text-left',
            itemView && 'cursor-pointer hover:bg-black/5',
            !itemView && 'cursor-default',
            itemView === view && 'bg-black/5 font-medium'
          )}
        >
          <Icon className="h-4 w-4 text-[var(--text2)]" />
          {t(`sidebar.${key}`)}
        </button>
      ))}
      <div className="px-2 pb-1.5 pt-3 text-[11px] font-semibold text-[var(--text3)]">
        {t('sidebar.chats')}
      </div>
      {/* 북마크 섹션만 스크롤되어야 아래 설정 푸터가 항상 보인다 */}
      <BookmarkTree />
      {/* 설정 페이지 진입점 (신규 추가분) */}
      <button
        type="button"
        onClick={() => setView('settings')}
        className={cn(
          'mt-auto flex items-center gap-2 border-t border-black/5 px-2 pt-2 text-left text-[var(--text2)] hover:text-[var(--text)]',
          view === 'settings' && 'font-medium text-[var(--text)]'
        )}
      >
        <Settings className="h-4 w-4" />
        {t('sidebar.settings')}
      </button>
    </aside>
  )
}
