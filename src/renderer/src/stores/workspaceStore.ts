import { create } from 'zustand'
import type { WorkspaceDto } from '@shared/sync'
import i18n from '@renderer/i18n'

// 작업공간(브라우저 프로필) 목록과 활성 작업공간. 진실 원천은 메인이고,
// 여기 값은 IPC 응답과 workspace:changed 이벤트를 그대로 비춘다.
interface WorkspaceState {
  items: WorkspaceDto[]
  loading: boolean
  error: string | null
  // 전환 직후 한 번 보여 주는 안내 띠(이미 열린 탭은 이전 세션을 유지한다는 안내)
  switchedNotice: boolean
  load: () => Promise<void>
  create: (name: string) => Promise<void>
  switchTo: (id: number) => Promise<void>
  rename: (id: number, name: string) => Promise<void>
  remove: (id: number) => Promise<void>
  dismissNotice: () => void
  // 메인이 밀어 준 변경(단축키 전환 포함)을 반영한다
  applyChanged: (w: WorkspaceDto) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  // IPC 호출 공통 처리 — 실패하면 error 에 메시지를 남기고 목록은 건드리지 않는다
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    set({ error: null })
    const r = await fn()
    if (!r.ok) {
      set({ error: r.error ?? i18n.t('workspace.requestFailed') })
      return false
    }
    return true
  }

  return {
    items: [],
    loading: false,
    error: null,
    switchedNotice: false,

    load: async () => {
      set({ loading: true })
      const r = await window.samba.workspace.list()
      if (r.ok) set({ items: r.data, loading: false, error: null })
      else set({ loading: false, error: r.error })
    },

    create: async (name) => {
      if (await run(() => window.samba.workspace.create(name))) await get().load()
    },

    switchTo: async (id) => {
      if (get().items.find((w) => w.id === id)?.isActive) return
      if (await run(() => window.samba.workspace.switch(id))) {
        set({ switchedNotice: true })
        await get().load()
      }
    },

    rename: async (id, name) => {
      if (await run(() => window.samba.workspace.rename(id, name))) await get().load()
    },

    remove: async (id) => {
      if (await run(() => window.samba.workspace.remove(id))) await get().load()
    },

    dismissNotice: () => set({ switchedNotice: false }),

    applyChanged: (w) => {
      set((s) => ({
        items: s.items.map((item) => ({ ...item, isActive: item.id === w.id })),
        switchedNotice: true
      }))
      void get().load()
    }
  }
})
