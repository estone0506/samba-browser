import { create } from 'zustand'

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
  setPanelWidth: (w: number) => void
  setView: (v: MainView) => void
  toggleVaultPanel: () => void
  closeVaultPanel: () => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: 232,
  panelWidth: 380,
  view: 'browser',
  vaultPanelOpen: false,
  setPanelWidth: (w) => set({ panelWidth: Math.max(280, Math.min(600, w)) }),
  setView: (v) => set({ view: v }),
  toggleVaultPanel: () => set((s) => ({ vaultPanelOpen: !s.vaultPanelOpen })),
  closeVaultPanel: () => set({ vaultPanelOpen: false })
}))
