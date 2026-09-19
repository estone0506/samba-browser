import type React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useUiStore } from '@renderer/stores/uiStore'
import { isSectionOpen, type SidebarSectionKey } from './sidebar-view'

interface Props {
  sectionKey: SidebarSectionKey
  label: string
  // 헤더 오른쪽에 붙는 보조 버튼(예: 북마크 "관리"). 접기 토글과 겹치지 않게 별도 슬롯이다
  action?: React.ReactNode
}

/**
 * 사이드바 섹션(열린 탭·채팅·북마크)의 공통 헤더.
 * 헤더를 누르면 섹션을 접었다 펴고, 그 상태를 곧바로 설정에 저장한다(기기 로컬)
 */
export function SectionHeader({ sectionKey, label, action }: Props): React.JSX.Element {
  const open = useUiStore((s) => isSectionOpen(s.sidebarSections, sectionKey))
  const toggle = useUiStore((s) => s.toggleSidebarSection)
  return (
    <div className="flex items-center justify-between gap-1 px-2 pb-1.5 pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => void window.samba.settings.set({ sidebarSections: toggle(sectionKey) })}
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold text-[var(--text3)] hover:text-[var(--text2)]"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="truncate">{label}</span>
      </button>
      {action}
    </div>
  )
}
