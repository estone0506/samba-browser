import { create } from 'zustand'
import type {
  AccountDto,
  AgentAccess,
  AuditLogDto,
  FieldKind,
  CapturePromptDto,
  ImportBookmarksResult,
  ImportPasswordsResult,
  PasswordUpdatedDto,
  SiteDto,
  VaultItemMeta,
  VaultItemType,
  VaultState
} from '@shared/ipc'

// 계정 목록에서 선택 가능한 대상: 특정 계정(number) · 전역 항목(accountId=null) · 없음
export type SelectedAccount = number | 'global' | null

export interface PutFieldInput {
  key: string
  label: string
  kind: FieldKind
  // 생략하면 메인이 기존 암호문을 유지한다(편집에서 "비워두면 유지")
  value?: string
}

export interface PutSectionInput {
  key: string
  label: string
  fields: PutFieldInput[]
}

interface PutItemInput {
  // 편집 대상 항목 id. 주면 그 항목을 그대로 갱신한다(라벨·종류 변경 포함)
  id?: number
  accountId: number | null
  type: VaultItemType
  label: string
  value?: string
  sections?: PutSectionInput[]
}

interface UpsertAccountInput {
  id?: number
  host: string
  // 생략하면 메인이 기존 계정의 라벨을 유지한다
  label?: string
  username: string
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
  urls?: string[]
  agentAccess?: AgentAccess
  tags?: string[]
}

// 목록 정렬 기준
export type VaultSort = 'name' | 'recent'

interface VaultStoreState {
  state: VaultState
  sites: SiteDto[]
  accounts: AccountDto[]
  // 계정별 항목 메타. 전역 항목은 'global' 키에 담는다(값은 절대 담지 않는다)
  itemsByAccount: Record<string, VaultItemMeta[]>
  selectedAccountId: SelectedAccount
  // 전역 항목 목록에서 선택된 개별 항목(계정이 없는 항목이라 accountId 만으론 특정할 수 없다)
  selectedGlobalItemId: number | null
  query: string
  // 필터·정렬(목록 상단 바)
  typeFilter: VaultItemType | 'all'
  tagFilter: string[]
  sort: VaultSort
  // 최근 사용(감사 로그에서 계산한 계정 id 목록, 최신순)
  recentAccountIds: number[]
  // 펼쳐 둔 도메인 그룹 키(registrableDomain). 기본은 모두 접힘이라 비어 있다
  expandedGroups: Set<string>
  // 방금 지운 계정의 되돌리기 안내(토스트). 토큰만 들고 있고 값은 메인에 남는다
  pendingUndo: { token: string; count: number } | null
  loading: boolean
  error: string | null
  // 자동 저장 제안 카드. main 이 push 한 것을 그대로 담아둔다(비밀번호는 담기지 않음)
  capture: CapturePromptDto | null
  captureSubscribed: boolean
  // 로그인 성공 감지로 비밀번호가 자동 갱신됐을 때의 토스트. main 이 push 한 것을 그대로 담아둔다
  passwordUpdated: PasswordUpdatedDto | null
  passwordUpdatedSubscribed: boolean
  // CapturePrompt 인라인 잠금 해제 폼 상태. capture 대상(host/username)이 바뀌면 store 레벨에서 초기화한다
  captureUnlocking: boolean
  capturePw: string
  captureErr: string | null
  subscribeCapture: () => void
  setCapture: (prompt: CapturePromptDto | null) => void
  decideCapture: (accept: boolean) => void
  // 자동 갱신 토스트 구독·상태·되돌리기
  subscribePasswordUpdated: () => void
  setPasswordUpdated: (dto: PasswordUpdatedDto | null) => void
  undoPasswordUpdate: () => void
  setCaptureUnlocking: (v: boolean) => void
  setCapturePw: (v: string) => void
  setCaptureErr: (v: string | null) => void
  refreshState: () => Promise<void>
  setup: (master: string, remember: boolean) => Promise<boolean>
  unlock: (master: string, remember: boolean) => Promise<boolean>
  // CapturePrompt 인라인 잠금 해제 전용. settings.set(vaultRememberDevice) 를 호출하지 않는다 —
  // 이걸 unlock() 처럼 remember=false 로 부르면 기기 기억 설정이 영구적으로 꺼져버린다
  unlockOnly: (master: string) => Promise<boolean>
  lock: () => Promise<void>
  /** 이 PC 금고를 계정 마스터 키에 맞춘다. 결과 코드를 돌려준다 */
  rekeyToAccount: (master: string) => Promise<string>
  loadAccounts: () => Promise<void>
  select: (id: SelectedAccount) => void
  selectGlobalItem: (id: number) => void
  loadItems: (accountId: number | null) => Promise<void>
  putItem: (input: PutItemInput) => Promise<boolean>
  deleteItem: (id: number, accountId: number | null) => Promise<void>
  // 사용자가 '보기'를 눌렀을 때만 호출. 반환값은 store 에 저장하지 않고 호출자에게만 준다
  reveal: (id: number, fieldKey?: string) => Promise<string | null>
  upsertAccount: (dto: UpsertAccountInput) => Promise<AccountDto | null>
  setQuery: (q: string) => void
  setTypeFilter: (t: VaultItemType | 'all') => void
  toggleTagFilter: (tag: string) => void
  setSort: (s: VaultSort) => void
  loadRecent: () => Promise<void>
  toggleGroup: (key: string) => void
  // 계정(들) 삭제 — 성공하면 되돌리기 토스트가 뜬다
  deleteAccounts: (ids: number[]) => Promise<void>
  undoDelete: () => Promise<void>
  /** 같은 사이트 같은 아이디 계정 합치기. 지운 계정은 되돌리기 토스트로 되살린다 */
  mergeDomain: (domain: string) => Promise<void>
  clearPendingUndo: () => void
  expandAllGroups: (keys: string[]) => void
  collapseAllGroups: () => void
  // 사용자가 누르는 '자동 채우기'. 결과 문자열만 돌려받는다(값은 메인에 머문다)
  autofill: (accountId: number) => Promise<string | null>
  importPasswords: () => Promise<ImportPasswordsResult | null>
  importBookmarks: () => Promise<ImportBookmarksResult | null>
}

// 최근 사용 목록에 보여 줄 계정 수
const RECENT_LIMIT = 5

function itemsKey(accountId: number | null): string {
  return accountId === null ? 'global' : String(accountId)
}

export const useVaultStore = create<VaultStoreState>((set, get) => ({
  state: 'uninitialized',
  sites: [],
  accounts: [],
  itemsByAccount: {},
  selectedAccountId: null,
  selectedGlobalItemId: null,
  query: '',
  typeFilter: 'all',
  tagFilter: [],
  sort: 'name',
  recentAccountIds: [],
  expandedGroups: new Set<string>(),
  pendingUndo: null,
  loading: false,
  error: null,
  capture: null,
  captureSubscribed: false,
  captureUnlocking: false,
  capturePw: '',
  captureErr: null,
  passwordUpdated: null,
  passwordUpdatedSubscribed: false,

  // App 마운트 시 한 번만 구독한다(중복 구독 방지)
  subscribeCapture: () => {
    if (get().captureSubscribed) return
    set({ captureSubscribed: true })
    window.samba.vault.onCapturePrompt((prompt) => get().setCapture(prompt))
  },

  // capture 대상(host/username)이 이전과 다르면(다른 프롬프트로 교체된 경우) 인라인 잠금
  // 해제 폼 상태를 초기화한다. null 로 치울 때도 마찬가지로 정리한다
  setCapture: (prompt) =>
    set((s) => {
      const changed =
        !s.capture ||
        !prompt ||
        s.capture.host !== prompt.host ||
        s.capture.username !== prompt.username
      return changed
        ? { capture: prompt, captureUnlocking: false, capturePw: '', captureErr: null }
        : { capture: prompt }
    }),

  decideCapture: (accept) => {
    // 잠긴 상태에서 '저장'을 누르면 메인이 조용히 버린다. 대신 카드에서 잠금 해제를
    // 요구하고 그 이유를 알린다(captureErr 는 번역된 문장이 아니라 i18n 키다)
    if (accept && get().state !== 'unlocked') {
      set({ captureUnlocking: true, captureErr: 'capture.lockedNotice' })
      return
    }
    window.samba.vault.captureDecision(accept)
    set({ capture: null, captureUnlocking: false, capturePw: '', captureErr: null })
  },

  setCaptureUnlocking: (v) => set({ captureUnlocking: v }),
  setCapturePw: (v) => set({ capturePw: v }),
  setCaptureErr: (v) => set({ captureErr: v }),

  // App 마운트 시 한 번만 구독한다(중복 구독 방지)
  subscribePasswordUpdated: () => {
    if (get().passwordUpdatedSubscribed) return
    set({ passwordUpdatedSubscribed: true })
    window.samba.vault.onPasswordUpdated((dto) => get().setPasswordUpdated(dto))
  },

  setPasswordUpdated: (dto) => set({ passwordUpdated: dto }),

  undoPasswordUpdate: () => {
    const dto = get().passwordUpdated
    if (!dto) return
    window.samba.vault.undoPasswordUpdate(dto.undoToken)
    set({ passwordUpdated: null })
  },

  refreshState: async () => {
    const r = await window.samba.vault.state()
    if (!r.ok) return
    set({ state: r.data })
    if (r.data === 'unlocked') {
      await get().loadAccounts()
    } else {
      set({ sites: [], accounts: [], itemsByAccount: {}, selectedAccountId: null })
    }
  },

  setup: async (master, remember) => {
    set({ loading: true, error: null })
    await window.samba.settings.set({ vaultRememberDevice: remember })
    const r = await window.samba.vault.setup(master)
    if (!r.ok) {
      set({ loading: false, error: r.error })
      return false
    }
    await get().refreshState()
    set({ loading: false })
    return true
  },

  unlock: async (master, remember) => {
    set({ loading: true, error: null })
    await window.samba.settings.set({ vaultRememberDevice: remember })
    const r = await window.samba.vault.unlock(master)
    if (!r.ok) {
      set({ loading: false, error: r.error })
      return false
    }
    if (!r.data) {
      set({ loading: false, error: 'invalid' })
      return false
    }
    await get().refreshState()
    set({ loading: false })
    return true
  },

  unlockOnly: async (master) => {
    set({ loading: true, error: null })
    const r = await window.samba.vault.unlock(master)
    if (!r.ok) {
      set({ loading: false, error: r.error })
      return false
    }
    if (!r.data) {
      set({ loading: false, error: 'invalid' })
      return false
    }
    await get().refreshState()
    set({ loading: false })
    return true
  },

  lock: async () => {
    await window.samba.vault.lock()
    await get().refreshState()
  },
  rekeyToAccount: async (master) => {
    const r = await window.samba.vault.rekeyToAccount(master)
    if (!r.ok) return 'error'
    await get().refreshState()
    return r.data
  },

  loadAccounts: async () => {
    const [sitesR, accountsR] = await Promise.all([
      window.samba.vault.sites(),
      window.samba.vault.accounts()
    ])
    set({
      sites: sitesR.ok ? sitesR.data : [],
      accounts: accountsR.ok ? accountsR.data : []
    })
  },

  select: (id) => {
    set({ selectedAccountId: id, selectedGlobalItemId: null })
    void get().loadItems(id === 'global' || id === null ? null : id)
  },

  selectGlobalItem: (id) => {
    set({ selectedAccountId: 'global', selectedGlobalItemId: id })
  },

  loadItems: async (accountId) => {
    const r = await window.samba.vault.items(accountId)
    if (!r.ok) return
    set((s) => ({ itemsByAccount: { ...s.itemsByAccount, [itemsKey(accountId)]: r.data } }))
  },

  putItem: async (input) => {
    const r = await window.samba.vault.putItem(input)
    if (!r.ok) {
      set({ error: r.error })
      return false
    }
    await get().loadItems(input.accountId)
    return true
  },

  deleteItem: async (id, accountId) => {
    const r = await window.samba.vault.deleteItem(id)
    if (r.ok) await get().loadItems(accountId)
  },

  reveal: async (id, fieldKey) => {
    const r = await window.samba.vault.reveal(id, fieldKey)
    return r.ok ? r.data : null
  },

  upsertAccount: async (dto) => {
    const r = await window.samba.vault.upsertAccount(dto)
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    await get().loadAccounts()
    return r.data
  },

  setQuery: (q) => set({ query: q }),

  setTypeFilter: (t) => set({ typeFilter: t }),

  toggleTagFilter: (tag) =>
    set((s) => ({
      tagFilter: s.tagFilter.includes(tag)
        ? s.tagFilter.filter((x) => x !== tag)
        : [...s.tagFilter, tag]
    })),

  setSort: (sort) => set({ sort }),

  // 그룹 헤더 접기/펼치기. Set 은 새 인스턴스로 갈아 끼워 리렌더를 일으킨다
  toggleGroup: (key) =>
    set((s) => {
      const next = new Set(s.expandedGroups)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { expandedGroups: next }
    }),

  expandAllGroups: (keys) => set({ expandedGroups: new Set(keys) }),

  collapseAllGroups: () => set({ expandedGroups: new Set<string>() }),

  deleteAccounts: async (ids) => {
    if (ids.length === 0) return
    const r = await window.samba.vault.deleteAccounts(ids)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    // 지워진 계정이 선택돼 있었다면 선택을 푼다
    set((s) => ({
      pendingUndo: r.data,
      selectedAccountId:
        typeof s.selectedAccountId === 'number' && ids.includes(s.selectedAccountId)
          ? null
          : s.selectedAccountId
    }))
    await get().loadAccounts()
    await get().loadRecent()
  },

  mergeDomain: async (domain) => {
    const r = await window.samba.vault.mergeDomain(domain)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    if (r.data.token !== null) {
      const token = r.data.token
      set((s) => ({
        pendingUndo: { token, count: r.data.removed },
        selectedAccountId: typeof s.selectedAccountId === 'number' ? null : s.selectedAccountId
      }))
    }
    await get().loadAccounts()
    await get().loadRecent()
  },

  undoDelete: async () => {
    const pending = get().pendingUndo
    if (!pending) return
    set({ pendingUndo: null })
    const r = await window.samba.vault.undoDelete(pending.token)
    if (!r.ok || !r.data) return
    await get().loadAccounts()
    await get().loadRecent()
  },

  clearPendingUndo: () => set({ pendingUndo: null }),

  // 최근 사용 계정 — 감사 로그의 fill/reveal 기록에서 계정 id 를 최신순으로 뽑는다
  loadRecent: async () => {
    const r = await window.samba.vault.audit()
    if (!r.ok) return
    const ids: number[] = []
    for (const log of r.data as AuditLogDto[]) {
      if (log.action !== 'fill' && log.action !== 'reveal') continue
      if (log.accountId === null || ids.includes(log.accountId)) continue
      ids.push(log.accountId)
    }
    set({ recentAccountIds: ids.slice(0, RECENT_LIMIT) })
  },

  autofill: async (accountId) => {
    const r = await window.samba.vault.autofill(accountId)
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    await get().loadRecent()
    return r.data
  },

  importPasswords: async () => {
    const r = await window.samba.importData.passwords()
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    await get().loadAccounts()
    return r.data
  },

  importBookmarks: async () => {
    const r = await window.samba.importData.bookmarks()
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    return r.data
  }
}))
