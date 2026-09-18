import { create } from 'zustand'

interface UiState {
  sidebarWidth: number
  panelWidth: number
  setPanelWidth: (w: number) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: 232,
  panelWidth: 380,
  setPanelWidth: (w) => set({ panelWidth: Math.max(280, Math.min(600, w)) })
}))
