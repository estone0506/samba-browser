import { create } from 'zustand'
import type { RecommendApplyDto, RecommendDto } from '@shared/activity-patterns'

// 예약 추천. 후보는 메인이 기기 로컬 기록에서 규칙으로 뽑아 준다(AI 호출 없음).
// 화면은 후보만 받고 기록 자체는 건너오지 않는다
interface RecommendState {
  items: RecommendDto[]
  /** 적용에 실패했을 때만 채운다(빈 문자열이면 문제 없음) */
  error: string
  load: () => Promise<void>
  /** [숨기기] — 30일 뒤 다시 나타난다 */
  dismiss: (key: string) => Promise<void>
  /** [예약 만들기] — 새로 만들었으면 편집기를 열도록 결과를 돌려준다 */
  apply: (key: string) => Promise<RecommendApplyDto | null>
  /** 설정의 "지금까지 기록 지우기" */
  clearHistory: () => Promise<boolean>
}

export const useRecommendStore = create<RecommendState>((set, get) => ({
  items: [],
  error: '',
  load: async () => {
    const r = await window.samba.activity?.recommend()
    if (!r?.ok) return
    set({ items: r.data })
  },
  dismiss: async (key) => {
    await window.samba.activity?.dismiss(key)
    await get().load()
  },
  apply: async (key) => {
    const r = await window.samba.activity?.apply(key)
    if (!r?.ok || r.data === null) {
      set({ error: 'apply' })
      return null
    }
    set({ error: '' })
    await get().load()
    return r.data
  },
  clearHistory: async () => {
    const r = await window.samba.activity?.clear()
    await get().load()
    return r?.ok === true && r.data
  }
}))
