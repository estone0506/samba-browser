import { create } from 'zustand'
import type { SiteMemorySummary } from '@shared/ipc'

// 사이트 기억. 화면이 받는 것은 호스트별 개수뿐이고, 경로·메모 본문은 메인에 남는다
interface SiteMemoryState {
  items: SiteMemorySummary[]
  load: () => Promise<void>
  /** 호스트 한 곳의 기억 [지우기] */
  forget: (host: string) => Promise<void>
}

export const useSiteMemoryStore = create<SiteMemoryState>((set, get) => ({
  items: [],
  load: async () => {
    const r = await window.samba.siteMemory?.list()
    if (!r?.ok) return
    set({ items: r.data })
  },
  forget: async (host) => {
    await window.samba.siteMemory?.forget(host)
    await get().load()
  }
}))
