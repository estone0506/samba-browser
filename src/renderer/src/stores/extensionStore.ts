import { create } from 'zustand'
import type { ExtensionDto, ExtensionError } from '@shared/extensions'

// 확장 목록은 전용 페이지와 주소창 퍼즐 메뉴 두 곳에서 쓰므로 한 곳에 모아 둔다.
// 목록을 바꾸는 일은 전부 메인에서 벌어지고, 여기는 그 결과를 다시 읽기만 한다
interface ExtensionState {
  items: ExtensionDto[]
  /** 앱 시작 시 로드에 실패한 폴더들 — 앱은 그대로 뜨고 화면에만 남는다 */
  loadErrors: ExtensionError[]
  /** 마지막 조작이 실패했을 때의 사유(성공하면 빈 문자열) */
  message: string
  busy: boolean
  load: () => Promise<void>
  /** 폴더 선택창은 메인이 연다. 취소하면 목록을 건드리지 않는다 */
  addFolder: () => Promise<void>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  clearMessage: () => void
}

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  items: [],
  loadErrors: [],
  message: '',
  busy: false,

  load: async () => {
    const r = await window.samba.extensions.list()
    if (!r.ok) {
      set({ message: r.error })
      return
    }
    set({ items: r.data.items, loadErrors: r.data.errors })
  },

  addFolder: async () => {
    set({ busy: true, message: '' })
    try {
      const r = await window.samba.extensions.load()
      if (!r.ok) {
        set({ message: r.error })
        return
      }
      if (r.data) await get().load()
    } finally {
      set({ busy: false })
    }
  },

  remove: async (id) => {
    const r = await window.samba.extensions.remove(id)
    if (!r.ok) {
      set({ message: r.error })
      return
    }
    await get().load()
  },

  setEnabled: async (id, enabled) => {
    const r = await window.samba.extensions.setEnabled(id, enabled)
    if (!r.ok) {
      // 켜다 실패하면 메인은 꺼진 상태를 그대로 두므로 화면도 다시 읽어 맞춘다
      set({ message: r.error })
      await get().load()
      return
    }
    const updated = r.data
    set((s) => ({ items: s.items.map((e) => (e.id === updated.id ? updated : e)), message: '' }))
  },

  clearMessage: () => set({ message: '' })
}))
