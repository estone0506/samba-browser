import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  MAX_PANEL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type SidebarSectionKey,
  type SidebarSections
} from '@shared/settings'
import { toggleSection } from '@renderer/components/layout/sidebar-view'

// 가운데 카드에 무엇을 그릴지. 'browser' 가 아니면 네이티브 웹뷰는 접히고
// 대신 렌더러가 그린 화면(개인정보 등)이 카드를 채운다
export type MainView = 'browser' | 'personal' | 'bookmarks' | 'phones' | 'extensions' | 'settings'

interface UiState {
  sidebarWidth: number
  // 사이드바를 아이콘 폭으로 접었는가(설정에 영속, 기기 로컬)
  sidebarCollapsed: boolean
  // 오른쪽 AI 패널 접힘
  panelCollapsed: boolean
  setPanelCollapsed: (v: boolean) => void
  togglePanel: () => boolean
  // 사이드바 안 섹션(열린 탭·채팅·북마크)의 펼침 상태(설정에 영속)
  sidebarSections: SidebarSections
  panelWidth: number
  view: MainView
  // 툴바 열쇠 아이콘으로 여는 키마스터 패널(오른쪽 AI 패널 상단 슬롯).
  // 네이티브 WebContentsView 는 항상 최상단이라 웹뷰 위 팝오버가 가려지므로,
  // 웹뷰 밖인 오른쪽 패널에 그린다
  vaultPanelOpen: boolean
  // 폭 드래그 중이면 true. 네이티브 웹뷰가 포인터를 가로채지 않도록 WebArea 가 뷰를 잠시 접는다
  resizing: boolean
  // 캡처 '직접 지정' 오버레이가 떠 있으면 true. 정지 이미지를 웹뷰가 덮지 않도록
  // resizing 과 똑같이 웹뷰를 잠시 접는다
  captureOverlayOpen: boolean
  setSidebarWidth: (w: number) => void
  setSidebarCollapsed: (v: boolean) => void
  // 토글 후의 접힘 상태를 돌려준다(호출부가 그대로 설정에 저장한다)
  toggleSidebar: () => boolean
  setSidebarSections: (s: SidebarSections) => void
  // 토글 후의 섹션 상태를 돌려준다(호출부가 그대로 설정에 저장한다)
  toggleSidebarSection: (key: SidebarSectionKey) => SidebarSections
  setPanelWidth: (w: number) => void
  setResizing: (v: boolean) => void
  setCaptureOverlayOpen: (v: boolean) => void
  setView: (v: MainView) => void
  toggleVaultPanel: () => void
  closeVaultPanel: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarWidth: 232,
  sidebarCollapsed: DEFAULT_SETTINGS.sidebarCollapsed,
  panelCollapsed: DEFAULT_SETTINGS.panelCollapsed,
  sidebarSections: { ...DEFAULT_SETTINGS.sidebarSections },
  panelWidth: 380,
  view: 'browser',
  vaultPanelOpen: false,
  resizing: false,
  captureOverlayOpen: false,
  setSidebarWidth: (w) =>
    set({ sidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, w)) }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setPanelCollapsed: (v) => set({ panelCollapsed: v }),
  togglePanel: () => {
    const next = !get().panelCollapsed
    set({ panelCollapsed: next })
    void window.samba.settings.set({ panelCollapsed: next })
    return next
  },
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    return next
  },
  setSidebarSections: (s) => set({ sidebarSections: { ...s } }),
  toggleSidebarSection: (key) => {
    const next = toggleSection(get().sidebarSections, key)
    set({ sidebarSections: next })
    return next
  },
  setPanelWidth: (w) =>
    set({ panelWidth: Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w)) }),
  setResizing: (v) => set({ resizing: v }),
  setCaptureOverlayOpen: (v) => set({ captureOverlayOpen: v }),
  setView: (v) => set({ view: v }),
  toggleVaultPanel: () => set((s) => ({ vaultPanelOpen: !s.vaultPanelOpen })),
  closeVaultPanel: () => set({ vaultPanelOpen: false })
}))
