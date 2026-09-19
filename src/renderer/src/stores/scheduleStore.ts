import { create } from 'zustand'
import type { ScheduleStatusDto } from '@shared/ipc'

// 플레이북 예약 상태. 설정은 플레이북에 실려 오고, 여기에는 "지금 어떤 상태인가"만 담는다.
// 메인이 상태를 바꿀 때마다 schedule:changed 를 보내므로 화면은 그때 다시 읽는다
interface ScheduleState {
  /** 플레이북 id → 예약 상태 */
  byId: Record<string, ScheduleStatusDto>
  load: () => Promise<void>
  /** 다른 작업이 돌고 있으면 false */
  runNow: (playbookId: string) => Promise<boolean>
  setPaused: (playbookId: string, paused: boolean) => Promise<void>
  /** 메인의 상태 변경 통지를 구독한다. 정리 함수를 돌려준다 */
  subscribe: () => () => void
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  byId: {},
  load: async () => {
    const r = await window.samba.schedule?.status()
    if (!r?.ok) return
    set({ byId: Object.fromEntries(r.data.map((row) => [row.playbookId, row])) })
  },
  runNow: async (playbookId) => {
    const r = await window.samba.schedule?.runNow(playbookId)
    await get().load()
    return r?.ok === true && r.data
  },
  setPaused: async (playbookId, paused) => {
    await window.samba.schedule?.setPaused(playbookId, paused)
    await get().load()
  },
  subscribe: () => window.samba.schedule?.onChanged(() => void get().load()) ?? ((): void => {})
}))
