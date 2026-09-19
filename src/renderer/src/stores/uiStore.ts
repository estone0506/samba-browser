import { create } from 'zustand'
import {
  MAX_PANEL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH
} from '@shared/settings'

// 가운데 카드에 무엇을 그릴지. 'browser' 가 아니면 네이티브 웹뷰는 접히고
// 대신 렌더러가 그린 화면(개인정보 등)이 카드를 채운다
export type MainView = 'browser' | 'personal' | 'bookmarks' | 'settings'

interface UiState {
  sidebarWidth: number
  panelWidth: number
  view: MainView
  // 툴바 열쇠 아이콘으로 여는 키마스터 패널(오른쪽 AI 패널 상단 슬롯).
  // 네이티브 WebContentsView 는 항상 최상단이라 웹뷰 위 팝오버가 가려지므로,
  // 웹뷰 밖인 오른쪽 패널에 그린다
  vaultPanelOpen: boolean
  // 폭 드래그 중이면 true. 네이티브 웹뷰가 포인터를 가로채지 않도록 WebArea 가 뷰를 잠시 접는다
  resizing: boolean
  setSidebarWidth: (w: number) => void
  setPanelWidth: (w: number) => void
  setResizing: (v: boolean) => void
  setView: (v: MainView) => void
  toggleVaultPanel: () => void
  closeVaultPanel: () => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: 232,
  panelWidth: 380,
  view: 'browser',
  vaultPanelOpen: false,
  resizing: false,
  setSidebarWidth: (w) =>
    set({ sidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, w)) }),
  setPanelWidth: (w) =>
    set({ panelWidth: Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w)) }),
  setResizing: (v) => set({ resizing: v }),
  setView: (v) => set({ view: v }),
  toggleVaultPanel: () => set((s) => ({ vaultPanelOpen: !s.vaultPanelOpen })),
  closeVaultPanel: () => set({ vaultPanelOpen: false })
}))
