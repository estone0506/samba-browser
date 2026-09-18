import { create } from 'zustand'
import type { SyncStatus } from '@shared/sync'

// 동기화 상태. 메인이 밀어 주는 sync:statusChanged 를 그대로 비춘다
interface SyncStoreState {
  status: SyncStatus | null
  syncing: boolean
  error: string | null
  load: () => Promise<void>
  subscribe: () => () => void
  syncNow: () => Promise<void>
}

export const useSyncStore = create<SyncStoreState>((set) => ({
  status: null,
  syncing: false,
  error: null,

  load: async () => {
    const r = await window.samba.sync.status()
    if (r.ok) set({ status: r.data, error: null })
    else set({ error: r.error })
  },

  subscribe: () => window.samba.sync.onStatusChanged((status) => set({ status })),

  syncNow: async () => {
    set({ syncing: true, error: null })
    const r = await window.samba.sync.now()
    if (r.ok) set({ status: r.data, syncing: false })
    else set({ syncing: false, error: r.error })
  }
}))
