import { create } from 'zustand'

// 가운데 카드에 무엇을 그릴지. 'browser' 가 아니면 네이티브 웹뷰는 접히고
// 대신 렌더러가 그린 화면(개인정보 등)이 카드를 채운다
export type MainView = 'browser' | 'personal'

interface UiState {
  sidebarWidth: number
  panelWidth: number
  view: MainView
  setPanelWidth: (w: number) => void
  setView: (v: MainView) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: 232,
  panelWidth: 380,
  view: 'browser',
  setPanelWidth: (w) => set({ panelWidth: Math.max(280, Math.min(600, w)) }),
  setView: (v) => set({ view: v })
}))
