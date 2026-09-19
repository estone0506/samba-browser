import { create } from 'zustand'
import type { PhoneAuthWaitingDto, PhoneDto, ScreenMode } from '@shared/phone'
import { sortPhones } from '@renderer/components/phone/phone-view'

// 폰 목록·인증 대기·화면 모드를 담는 스토어.
// 진실 원천은 메인이고 여기 값은 phone:* IPC 응답과 phone:updated 이벤트를 그대로 비춘다.
// 결제 비밀번호·문자 본문은 어느 경로로도 여기에 오지 않는다.

interface PhoneStoreState {
  list: PhoneDto[]
  loading: boolean
  /** 연결 상한 초과처럼 사용자가 알아야 할 안내(메인이 보낸 문구) */
  warning: string | null
  error: string | null
  /** 인증 대기 알림. 해당 폰 카드를 자동으로 펼치고 테두리를 강조한다 */
  authWaiting: PhoneAuthWaitingDto | null
  /** 사용자가 펼쳐 둔(또는 인증 대기로 자동 펼친) 폰 id */
  expandedId: number | null
  /** serial → 지금 쓰는 화면 방식. 메인이 간이 화면으로 내려도 여기로 반영된다 */
  screenModes: Record<string, ScreenMode>
  /** 인증에 성공한 폰을 계정 담당 폰으로 제안하는 배너(계정 상세에서 쓴다) */
  assignSuggestion: { phoneId: number; siteHost: string } | null

  load: () => Promise<void>
  refresh: () => Promise<void>
  subscribe: () => () => void
  connectWifi: (address: string) => Promise<string | null>
  disconnect: (serial: string) => Promise<void>
  recover: (serial: string) => Promise<boolean>
  setLabel: (id: number, label: string, country: string) => Promise<void>
  assign: (accountId: number, phoneId: number | null) => Promise<boolean>
  toggleExpand: (id: number) => void
  setScreenMode: (serial: string, mode: ScreenMode | null) => void
  clearWarning: () => void
  clearError: () => void
  clearAssignSuggestion: () => void
}

export const usePhoneStore = create<PhoneStoreState>((set, get) => ({
  list: [],
  loading: false,
  warning: null,
  error: null,
  authWaiting: null,
  expandedId: null,
  screenModes: {},
  assignSuggestion: null,

  load: async () => {
    set({ loading: true })
    const r = await window.samba.phone.list()
    if (r.ok) set({ list: sortPhones(r.data), loading: false, error: null })
    else set({ loading: false, error: r.error })
  },

  refresh: async () => {
    set({ loading: true })
    const r = await window.samba.phone.refresh()
    if (r.ok) set({ list: sortPhones(r.data), loading: false, error: null })
    else set({ loading: false, error: r.error })
  },

  subscribe: () => {
    const offUpdated = window.samba.phone.onUpdated((list, warning) => {
      const next = sortPhones(list)
      // 사라진 폰의 화면 모드 기록은 같이 지운다
      const alive = new Set(next.map((p) => p.serial))
      const modes: Record<string, ScreenMode> = {}
      for (const [serial, mode] of Object.entries(get().screenModes)) {
        if (alive.has(serial)) modes[serial] = mode
      }
      // 메인이 보고한 screenMode 가 있으면 그 값이 우선이다
      for (const p of next) if (p.screenMode) modes[p.serial] = p.screenMode
      const expandedId = next.some((p) => p.id === get().expandedId) ? get().expandedId : null
      set({ list: next, screenModes: modes, expandedId, warning: warning ?? null })
    })
    const offAuth = window.samba.phone.onAuthWaiting((dto) => {
      if (!dto.waiting) {
        // 인증이 끝나면 카드를 접고, 배정 폰이 정해졌으면 담당 폰 제안 배너를 남긴다
        const suggestion =
          dto.phoneId === null ? null : { phoneId: dto.phoneId, siteHost: dto.siteHost }
        set({ authWaiting: null, expandedId: null, assignSuggestion: suggestion })
        return
      }
      set({ authWaiting: dto, expandedId: dto.phoneId ?? get().expandedId })
    })
    return () => {
      offUpdated()
      offAuth()
    }
  },

  connectWifi: async (address) => {
    const r = await window.samba.phone.connect(address)
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    await get().refresh()
    return r.data.message
  },

  disconnect: async (serial) => {
    const r = await window.samba.phone.disconnect(serial)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    await get().refresh()
  },

  recover: async (serial) => {
    const r = await window.samba.phone.recover(serial)
    if (!r.ok) {
      set({ error: r.error })
      return false
    }
    await get().refresh()
    return r.data
  },

  setLabel: async (id, label, country) => {
    const r = await window.samba.phone.setLabel(id, label, country)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    await get().refresh()
  },

  assign: async (accountId, phoneId) => {
    const r = await window.samba.phone.assign(accountId, phoneId)
    if (!r.ok) {
      set({ error: r.error })
      return false
    }
    set({ assignSuggestion: null })
    return true
  },

  toggleExpand: (id) => set((s) => ({ expandedId: s.expandedId === id ? null : id })),

  setScreenMode: (serial, mode) =>
    set((s) => {
      const modes = { ...s.screenModes }
      if (mode === null) delete modes[serial]
      else modes[serial] = mode
      return { screenModes: modes }
    }),

  clearWarning: () => set({ warning: null }),
  clearError: () => set({ error: null }),
  clearAssignSuggestion: () => set({ assignSuggestion: null })
}))
