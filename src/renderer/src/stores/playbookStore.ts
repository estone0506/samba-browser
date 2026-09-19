import { create } from 'zustand'
import type { PlaybookDto, PlaybookInput } from '@shared/playbook'

// 자동화 플레이북 목록 상태. 모든 변경은 메인에 저장한 뒤 목록을 다시 읽어 맞춘다
interface PlaybookState {
  items: PlaybookDto[]
  loading: boolean
  /** 마지막 실패 사유(화면에 한 줄로 보여 준다). 성공하면 비운다 */
  error: string
  load: () => Promise<void>
  /** 새로 만들거나 고친다. 성공하면 true */
  save: (input: PlaybookInput) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<boolean>
}

export const usePlaybookStore = create<PlaybookState>((set, get) => {
  // 쓰기 한 번 — 실패 사유를 남기고, 성공하면 목록을 다시 읽는다
  const write = async (run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    const r = await run()
    if (!r.ok) {
      set({ error: r.error ?? '' })
      return false
    }
    set({ error: '' })
    await get().load()
    return true
  }
  return {
    items: [],
    loading: false,
    error: '',
    load: async () => {
      set({ loading: true })
      const r = await window.samba.playbooks.list()
      if (r.ok) set({ items: r.data, loading: false, error: '' })
      else set({ loading: false, error: r.error })
    },
    save: (input) =>
      write(async () => {
        const r = await window.samba.playbooks.put(input)
        // 이름이 비었거나 없는 id 면 메인이 null 을 돌려준다 — 실패로 본다
        return r.ok && r.data === null ? { ok: false } : r
      }),
    // 내장 플레이북은 지워지지 않는다(false) — 화면에서 삭제 버튼 자체를 감춘다
    remove: (id) =>
      write(async () => {
        const r = await window.samba.playbooks.remove(id)
        return r.ok && !r.data ? { ok: false } : r
      }),
    restore: (id) =>
      write(async () => {
        const r = await window.samba.playbooks.restore(id)
        return r.ok && r.data === null ? { ok: false } : r
      })
  }
})
