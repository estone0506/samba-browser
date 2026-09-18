import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AgentEvent,
  type AgentRunAck,
  type IpcResult,
  type Layout,
  type Settings,
  type TabInfo,
  type AccountDto,
  type CapturePromptDto,
  type SiteDto,
  type VaultItemMeta,
  type VaultItemType,
  type VaultState,
  type ImportPasswordsResult,
  type ImportBookmarksResult,
  type BookmarkTreeDto
} from '../shared/ipc'

// 항목 저장 요청. value(평문)는 렌더러 → 메인 방향으로만 흐른다
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

// ipcRenderer.invoke 반환 타입이 Promise<any> 이므로 제네릭 헬퍼로 감싸 IpcResult<T> 를 명시
function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

// React UI가 쓰는 API. 반환은 전부 IpcResult
const api = {
  tabs: {
    list: (): Promise<IpcResult<TabInfo[]>> => invoke(IPC.tabList),
    create: (o: {
      url?: string
      profile?: string
      mobile?: boolean
    }): Promise<IpcResult<TabInfo>> => invoke(IPC.tabCreate, o),
    close: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabClose, id),
    activate: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabActivate, id),
    navigate: (id: string, url: string): Promise<IpcResult<void>> =>
      invoke(IPC.tabNavigate, id, url),
    back: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabBack, id),
    forward: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabForward, id),
    reload: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabReload, id),
    setMobile: (id: string, mobile: boolean): Promise<IpcResult<void>> =>
      invoke(IPC.tabSetMobile, id, mobile),
    onUpdated: (cb: (tabs: TabInfo[]) => void): (() => void) => {
      const h = (_: unknown, tabs: TabInfo[]): void => cb(tabs)
      ipcRenderer.on(IPC.tabUpdated, h)
      return () => ipcRenderer.off(IPC.tabUpdated, h)
    }
  },
  layout: {
    set: (l: Layout): Promise<IpcResult<void>> => invoke(IPC.layoutSet, l)
  },
  agent: {
    // 반환은 "시작 접수" ack 뿐. 완료·실패는 onEvent 의 status 이벤트로 온다
    run: (prompt: string): Promise<IpcResult<AgentRunAck>> => invoke(IPC.agentRun, prompt),
    stop: (): Promise<IpcResult<void>> => invoke(IPC.agentStop),
    confirmReply: (requestId: string, approved: boolean): void => {
      ipcRenderer.send(IPC.agentConfirmReply, requestId, approved)
    },
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const h = (_: unknown, e: AgentEvent): void => cb(e)
      ipcRenderer.on(IPC.agentEvent, h)
      return () => ipcRenderer.off(IPC.agentEvent, h)
    }
  },
  settings: {
    get: (): Promise<IpcResult<Settings>> => invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>): Promise<IpcResult<Settings>> => invoke(IPC.settingsSet, patch)
  },
  // 금고 — reveal 만이 평문을 돌려준다. 나머지는 상태·메타뿐이다
  vault: {
    state: (): Promise<IpcResult<VaultState>> => invoke(IPC.vaultState),
    setup: (master: string): Promise<IpcResult<void>> => invoke(IPC.vaultSetup, master),
    unlock: (master: string): Promise<IpcResult<boolean>> => invoke(IPC.vaultUnlock, master),
    lock: (): Promise<IpcResult<void>> => invoke(IPC.vaultLock),
    sites: (): Promise<IpcResult<SiteDto[]>> => invoke(IPC.vaultSites),
    accounts: (host?: string): Promise<IpcResult<AccountDto[]>> => invoke(IPC.vaultAccounts, host),
    items: (accountId: number | null): Promise<IpcResult<VaultItemMeta[]>> =>
      invoke(IPC.vaultItems, accountId),
    putItem: (input: PutItemInput): Promise<IpcResult<VaultItemMeta>> =>
      invoke(IPC.vaultPutItem, input),
    deleteItem: (id: number): Promise<IpcResult<void>> => invoke(IPC.vaultDeleteItem, id),
    // 사용자가 '보기' 를 눌렀을 때만 호출한다
    reveal: (id: number): Promise<IpcResult<string>> => invoke(IPC.vaultReveal, id),
    upsertAccount: (dto: UpsertAccountInput): Promise<IpcResult<AccountDto>> =>
      invoke(IPC.vaultUpsertAccount, dto),
    onStateChanged: (cb: (state: VaultState) => void): (() => void) => {
      const h = (_: unknown, state: VaultState): void => cb(state)
      ipcRenderer.on(IPC.vaultStateChanged, h)
      return () => ipcRenderer.off(IPC.vaultStateChanged, h)
    },
    onCapturePrompt: (cb: (prompt: CapturePromptDto) => void): (() => void) => {
      const h = (_: unknown, prompt: CapturePromptDto): void => cb(prompt)
      ipcRenderer.on(IPC.vaultCapturePrompt, h)
      return () => ipcRenderer.off(IPC.vaultCapturePrompt, h)
    },
    captureDecision: (accept: boolean): void => {
      ipcRenderer.send(IPC.vaultCaptureDecision, accept)
    }
  },
  // 가져오기 — filePath 생략 시 메인이 파일 선택 다이얼로그를 연다
  importData: {
    passwords: (filePath?: string): Promise<IpcResult<ImportPasswordsResult>> =>
      invoke(IPC.importPasswords, filePath),
    bookmarks: (filePath?: string): Promise<IpcResult<ImportBookmarksResult>> =>
      invoke(IPC.importBookmarks, filePath)
  },
  bookmarks: {
    tree: (): Promise<IpcResult<BookmarkTreeDto>> => invoke(IPC.bookmarksTree),
    remove: (id: number): Promise<IpcResult<void>> => invoke(IPC.bookmarksRemove, id)
  }
}

export type SambaApi = typeof api
contextBridge.exposeInMainWorld('samba', api)
