import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AgentEvent,
  type AgentRunAck,
  type IpcResult,
  type Layout,
  type Settings,
  type TabInfo
} from '../shared/ipc'

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
  }
}

export type SambaApi = typeof api
contextBridge.exposeInMainWorld('samba', api)
