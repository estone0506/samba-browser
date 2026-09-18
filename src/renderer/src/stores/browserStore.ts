import { create } from 'zustand'
import type { TabInfo } from '@shared/ipc'

interface BrowserState {
  tabs: TabInfo[]
  activeTab: TabInfo | null
  setTabs: (tabs: TabInfo[]) => void
  refresh: () => Promise<void>
  createTab: (url?: string) => Promise<void>
  closeTab: (id: string) => Promise<void>
  activateTab: (id: string) => Promise<void>
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  setMobile: (mobile: boolean) => Promise<void>
}

// 탭 상태는 메인이 진실. 렌더러는 이벤트로 복사본만 유지
export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTab: null,
  setTabs: (tabs) => set({ tabs, activeTab: tabs.find((t) => t.active) ?? null }),
  refresh: async () => {
    const r = await window.samba.tabs.list()
    if (r.ok) get().setTabs(r.data)
  },
  createTab: async (url) => {
    await window.samba.tabs.create({ url })
  },
  closeTab: async (id) => {
    await window.samba.tabs.close(id)
  },
  activateTab: async (id) => {
    await window.samba.tabs.activate(id)
  },
  navigate: async (url) => {
    const t = get().activeTab
    if (t) await window.samba.tabs.navigate(t.id, url)
  },
  back: async () => {
    const t = get().activeTab
    if (t) await window.samba.tabs.back(t.id)
  },
  forward: async () => {
    const t = get().activeTab
    if (t) await window.samba.tabs.forward(t.id)
  },
  reload: async () => {
    const t = get().activeTab
    if (t) await window.samba.tabs.reload(t.id)
  },
  setMobile: async (mobile) => {
    const t = get().activeTab
    if (t) await window.samba.tabs.setMobile(t.id, mobile)
  }
}))
