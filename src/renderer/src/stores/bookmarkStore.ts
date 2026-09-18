import { create } from 'zustand'
import type { BookmarkTreeDto } from '@shared/ipc'

interface BookmarkState {
  tree: BookmarkTreeDto | null
  // 펼쳐진 폴더 id 집합. 툴바 폴더는 기본 펼침 상태로 시작한다(load 에서 채움)
  expanded: Set<number>
  loading: boolean
  load: () => Promise<void>
  remove: (id: number) => Promise<void>
  toggle: (id: number) => void
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  tree: null,
  expanded: new Set(),
  loading: false,

  load: async () => {
    set({ loading: true })
    const r = await window.samba.bookmarks.tree()
    if (r.ok) {
      set((s) => {
        // 이미 펼친 적 있는 폴더 상태는 유지하고, 첫 로드 시 툴바 폴더만 기본으로 펼친다
        const expanded = s.expanded.size > 0 ? s.expanded : new Set<number>()
        if (expanded.size === 0) {
          for (const f of r.data.folders) if (f.isToolbar) expanded.add(f.id)
        }
        return { tree: r.data, expanded, loading: false }
      })
    } else {
      set({ loading: false })
    }
  },

  remove: async (id) => {
    const r = await window.samba.bookmarks.remove(id)
    if (r.ok) await get().load()
  },

  toggle: (id) => {
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: next }
    })
  }
}))
