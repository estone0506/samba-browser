import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Globe,
  ListChecks,
  PanelLeft,
  Repeat,
  KeyRound,
  Smartphone,
  ScrollText,
  Settings
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import logo from '@renderer/assets/logo.png'
import { useUiStore, type MainView } from '@renderer/stores/uiStore'
import { BookmarkTree } from './BookmarkTree'
import { ChatList } from './ChatList'
import { OpenTabs } from './OpenTabs'
import { SectionHeader } from './SectionHeader'
import { showSectionBody } from './sidebar-view'
import { WorkspaceSwitcher } from '@renderer/components/workspace/WorkspaceSwitcher'

// 사이드바 항목 중 아직 뷰가 없는 항목(작업·로그)은 클릭해도 아무 일도 하지 않는다
const ITEMS = [
  { key: 'browser', icon: Globe, view: 'browser' },
  { key: 'tasks', icon: ListChecks, view: null },
  { key: 'automation', icon: Repeat, view: 'automation' },
  { key: 'accounts', icon: KeyRound, view: 'personal' },
  { key: 'phones', icon: Smartphone, view: 'phones' },
  { key: 'logs', icon: ScrollText, view: null }
] as const satisfies readonly { key: string; icon: typeof Globe; view: MainView | null }[]

export function Sidebar({ width }: { width: number }): React.JSX.Element {
  const { t } = useTranslation()
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const sections = useUiStore((s) => s.sidebarSections)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  return (
    <aside
      style={{ width }}
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-r border-[var(--line)] bg-[#f6f6f8]/90 pt-10 backdrop-blur',
        collapsed ? 'items-center p-1.5' : 'p-2.5'
      )}
    >
      {/* 접기 토글 + 제품 이름. 접히면 아이콘만 남는다 */}
      <div className={cn('flex items-center pb-3', collapsed ? 'justify-center' : 'gap-1.5 px-1')}>
        <button
          type="button"
          aria-label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
          title={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
          onClick={() => void window.samba.settings.set({ sidebarCollapsed: toggleSidebar() })}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[var(--text2)] hover:bg-black/5 hover:text-[var(--text)]"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
            <img src={logo} alt="" className="h-[22px] w-[22px] rounded-[7px]" />
            <span className="truncate">{t('app.name')}</span>
          </div>
        )}
      </div>
      {/* 작업공간 전환기 (신규 추가분) — 접힌 폭에서는 이름이 들어가지 않아 숨긴다 */}
      {!collapsed && <WorkspaceSwitcher />}
      {ITEMS.map(({ key, icon: Icon, view: itemView }) => (
        <button
          key={key}
          type="button"
          title={t(`sidebar.${key}`)}
          aria-label={t(`sidebar.${key}`)}
          onClick={() => itemView && setView(itemView)}
          className={cn(
            'flex items-center rounded-[9px] text-left',
            collapsed ? 'h-8 w-8 justify-center' : 'gap-2 px-2 py-1.5',
            itemView && 'cursor-pointer hover:bg-black/5',
            !itemView && 'cursor-default',
            itemView === view && 'bg-black/5 font-medium'
          )}
        >
          <Icon className="h-4 w-4 shrink-0 text-[var(--text2)]" />
          {!collapsed && t(`sidebar.${key}`)}
        </button>
      ))}
      {!collapsed && (
        <>
          {/* 열린 탭 — 위쪽 TabBar 와 같은 목록을 세로로 (신규 추가분) */}
          <SectionHeader sectionKey="tabs" label={t('tab.openTabs')} />
          {showSectionBody(collapsed, sections, 'tabs') && <OpenTabs />}
          {/* 최근 대화 목록 (신규 추가분) */}
          <SectionHeader sectionKey="chat" label={t('sidebar.chats')} />
          {showSectionBody(collapsed, sections, 'chat') && <ChatList />}
        </>
      )}
      {/* 북마크 섹션만 스크롤되어야 아래 설정 푸터가 항상 보인다 */}
      {!collapsed && <BookmarkTree />}
      {/* 설정 페이지 진입점 (신규 추가분) */}
      <button
        type="button"
        title={t('sidebar.settings')}
        aria-label={t('sidebar.settings')}
        onClick={() => setView('settings')}
        className={cn(
          'mt-auto flex items-center border-t border-black/5 text-left text-[var(--text2)] hover:text-[var(--text)]',
          collapsed ? 'w-8 justify-center pt-2' : 'gap-2 px-2 pt-2',
          view === 'settings' && 'font-medium text-[var(--text)]'
        )}
      >
        <Settings className="h-4 w-4 shrink-0" />
        {!collapsed && t('sidebar.settings')}
      </button>
    </aside>
  )
}
