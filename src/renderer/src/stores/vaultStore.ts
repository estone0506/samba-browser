import { create } from 'zustand'
import type {
  AccountDto,
  CapturePromptDto,
  ImportBookmarksResult,
  ImportPasswordsResult,
  SiteDto,
  VaultItemMeta,
  VaultItemType,
  VaultState
} from '@shared/ipc'

// 계정 목록에서 선택 가능한 대상: 특정 계정(number) · 전역 항목(accountId=null) · 없음
export type SelectedAccount = number | 'global' | null

interface PutItemInput {
  accountId: number | null
  type: VaultItemType
  label: string
  value: string
}

interface UpsertAccountInput {
  id?: number
  host: string
  label: string
  username: string
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
}

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
  loading: boolean
  error: string | null
  // 자동 저장 제안 카드. main 이 push 한 것을 그대로 담아둔다(비밀번호는 담기지 않음)
  capture: CapturePromptDto | null
  captureSubscribed: boolean
  subscribeCapture: () => void
  setCapture: (prompt: CapturePromptDto | null) => void
  decideCapture: (accept: boolean) => void
  refreshState: () => Promise<void>
  setup: (master: string, remember: boolean) => Promise<boolean>
  unlock: (master: string, remember: boolean) => Promise<boolean>
  lock: () => Promise<void>
  loadAccounts: () => Promise<void>
  select: (id: SelectedAccount) => void
  selectGlobalItem: (id: number) => void
  loadItems: (accountId: number | null) => Promise<void>
  putItem: (input: PutItemInput) => Promise<boolean>
  deleteItem: (id: number, accountId: number | null) => Promise<void>
  // 사용자가 '보기'를 눌렀을 때만 호출. 반환값은 store 에 저장하지 않고 호출자에게만 준다
  reveal: (id: number) => Promise<string | null>
  upsertAccount: (dto: UpsertAccountInput) => Promise<AccountDto | null>
  setQuery: (q: string) => void
  importPasswords: () => Promise<ImportPasswordsResult | null>
  importBookmarks: () => Promise<ImportBookmarksResult | null>
}

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
  loading: false,
  error: null,
  capture: null,
  captureSubscribed: false,

  // App 마운트 시 한 번만 구독한다(중복 구독 방지)
  subscribeCapture: () => {
    if (get().captureSubscribed) return
    set({ captureSubscribed: true })
    window.samba.vault.onCapturePrompt((prompt) => set({ capture: prompt }))
  },

  setCapture: (prompt) => set({ capture: prompt }),

  decideCapture: (accept) => {
    window.samba.vault.captureDecision(accept)
    set({ capture: null })
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

  lock: async () => {
    await window.samba.vault.lock()
    await get().refreshState()
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

  reveal: async (id) => {
    const r = await window.samba.vault.reveal(id)
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
