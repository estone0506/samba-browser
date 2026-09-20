import { create } from 'zustand'
import type { ExtensionAnchorDto, ExtensionDto, ExtensionError } from '@shared/extensions'
import {
  migratePinned,
  parsePinned,
  togglePinned
} from '@renderer/components/extensions/extension-list'

// 예전 버전이 고정 목록을 담아 두던 localStorage 키. 이제는 설정으로 옮기고 지운다
const LEGACY_PINNED_KEY = 'samba.extensions.pinned'

/** 예전 키에 남아 있는 고정 목록을 읽는다. 저장소를 못 쓰는 환경이면 빈 목록 */
function readLegacyPinned(): string[] {
  try {
    return parsePinned(localStorage.getItem(LEGACY_PINNED_KEY))
  } catch {
    return []
  }
}

function clearLegacyPinned(): void {
  try {
    localStorage.removeItem(LEGACY_PINNED_KEY)
  } catch {
    // 지우지 못해도 다음 번에 설정 쪽이 이기므로 되살아나지 않는다
  }
}

/** 제거 되돌리기 토스트가 떠 있는 시간(ms) */
export const EXTENSION_UNDO_MS = 5000

/** 방금 제거한 확장 — 되돌리기는 같은 폴더를 다시 불러오는 것으로 끝난다 */
export interface RemovedExtension {
  id: string
  name: string
  path: string
}

// 되돌리기 토스트 타이머. 상태에 넣지 않는다(리렌더 대상이 아니다)
let undoTimer: number | null = null

function clearUndoTimer(): void {
  if (undoTimer === null) return
  clearTimeout(undoTimer)
  undoTimer = null
}

// 확장 목록은 전용 페이지와 주소창 퍼즐 메뉴 두 곳에서 쓰므로 한 곳에 모아 둔다.
// 목록을 바꾸는 일은 전부 메인에서 벌어지고, 여기는 그 결과를 다시 읽기만 한다
interface ExtensionState {
  items: ExtensionDto[]
  /** 앱 시작 시 로드에 실패한 폴더들 — 앱은 그대로 뜨고 화면에만 남는다 */
  loadErrors: ExtensionError[]
  /** 마지막 조작이 실패했을 때의 사유(성공하면 빈 문자열) */
  message: string
  busy: boolean
  /** 주소창 툴바에 고정한 확장 id(설정에 저장된다 — 기기 로컬, 동기화 안 함) */
  pinned: string[]
  /** 지금 팝업이 떠 있는 확장 id(툴바 버튼 눌림 표시용) */
  popupFor: string | null
  load: () => Promise<void>
  /** 설정에서 고정 목록을 읽고, 예전 localStorage 값이 있으면 한 번만 옮긴다 */
  loadPinned: () => Promise<void>
  togglePin: (id: string) => Promise<void>
  /** 툴바 아이콘·메뉴 항목 클릭 — 팝업을 띄우거나 옵션 페이지를 새 탭으로 연다 */
  runAction: (id: string, anchor: ExtensionAnchorDto) => Promise<void>
  closePopup: () => Promise<void>
  /** 메인이 팝업을 닫았다고 알려 왔을 때(바깥 클릭·Esc·탭 전환) */
  popupClosed: () => void
  /** 폴더 선택창은 메인이 연다. 취소하면 목록을 건드리지 않는다 */
  addFolder: () => Promise<void>
  remove: (id: string) => Promise<void>
  /** 방금 제거한 확장(되돌리기 토스트용). 5초가 지나면 null 로 돌아간다 */
  removed: RemovedExtension | null
  /** 되돌리기 — 제거한 폴더를 그대로 다시 불러온다 */
  undoRemove: () => Promise<void>
  /** 토스트를 닫는다(되돌리기 없이) */
  dismissRemoved: () => void
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  clearMessage: () => void
}

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  items: [],
  loadErrors: [],
  message: '',
  busy: false,
  pinned: [],
  popupFor: null,

  loadPinned: async () => {
    const r = await window.samba.settings.get()
    if (!r.ok) return
    const saved = r.data.extensionsPinned
    const moved = migratePinned(saved, readLegacyPinned())
    if (moved) {
      const written = await window.samba.settings.set({ extensionsPinned: moved })
      if (written.ok) clearLegacyPinned()
      set({ pinned: moved })
      return
    }
    // 옮길 것이 없으면 예전 키는 더 볼 일이 없다
    clearLegacyPinned()
    set({ pinned: saved })
  },

  togglePin: async (id) => {
    const before = get().pinned
    const next = togglePinned(before, id)
    // 먼저 화면을 바꾸고 저장한다 — 핀은 즉시 반응해야 크롬처럼 느껴진다
    set({ pinned: next })
    const r = await window.samba.settings.set({ extensionsPinned: next })
    // 저장에 실패하면 화면만 바뀐 채 다음 실행에 되돌아간다 — 사유를 남기고 즉시 되돌린다
    if (!r.ok) set({ pinned: [...before], message: r.error })
  },

  runAction: async (id, anchor) => {
    const r = await window.samba.extensions.action(id, anchor)
    if (!r.ok) {
      set({ message: r.error, popupFor: null })
      return
    }
    set({ message: '', popupFor: r.data.kind === 'popup' && r.data.open ? id : null })
  },

  closePopup: async () => {
    set({ popupFor: null })
    await window.samba.extensions.closePopup()
  },

  popupClosed: () => set({ popupFor: null }),

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

  removed: null,

  // 제거는 확인창 없이 바로 하되(크롬과 같다), 되돌릴 틈을 준다.
  // 제거해도 폴더는 디스크에 남으므로 같은 경로를 다시 불러오면 그대로 돌아온다
  remove: async (id) => {
    const item = get().items.find((e) => e.id === id)
    const r = await window.samba.extensions.remove(id)
    if (!r.ok) {
      set({ message: r.error })
      return
    }
    await get().load()
    if (!item) return
    clearUndoTimer()
    set({ removed: { id, name: item.name, path: item.path } })
    undoTimer = setTimeout(() => {
      undoTimer = null
      set({ removed: null })
    }, EXTENSION_UNDO_MS) as unknown as number
  },

  undoRemove: async () => {
    const target = get().removed
    clearUndoTimer()
    set({ removed: null })
    if (!target) return
    // 꺼 둔 확장이었더라도 되돌리면 켜진 상태로 돌아온다(add 는 항상 로드한다)
    const r = await window.samba.extensions.load(target.path)
    if (!r.ok) {
      set({ message: r.error })
      return
    }
    await get().load()
  },

  dismissRemoved: () => {
    clearUndoTimer()
    set({ removed: null })
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
