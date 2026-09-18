import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import type { TabManager } from '../browser/tab-manager'
import { SettingsStore } from '../settings/store'
import { AgentRunner } from '../agent/runner'

// 모든 핸들러는 {ok,data}|{ok:false,error}로 응답
function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e)
    }))
}

export function registerIpc(
  win: BrowserWindow,
  tabs: TabManager
): { settings: SettingsStore; agent: AgentRunner } {
  const settings = new SettingsStore()
  const agent = new AgentRunner(tabs, settings, (ev) => win.webContents.send(IPC.agentEvent, ev))

  tabs.onChange((list) => win.webContents.send(IPC.tabUpdated, list))

  ipcMain.handle(IPC.tabList, () => wrap(() => tabs.list()))
  ipcMain.handle(IPC.tabCreate, (_, o: { url?: string; profile?: string; mobile?: boolean }) =>
    wrap(() => tabs.create(o))
  )
  ipcMain.handle(IPC.tabClose, (_, id: string) => wrap(() => tabs.close(id)))
  ipcMain.handle(IPC.tabActivate, (_, id: string) => wrap(() => tabs.activate(id)))
  ipcMain.handle(IPC.tabNavigate, (_, id: string, url: string) =>
    wrap(() => tabs.navigate(id, url))
  )
  ipcMain.handle(IPC.tabBack, (_, id: string) => wrap(() => tabs.back(id)))
  ipcMain.handle(IPC.tabForward, (_, id: string) => wrap(() => tabs.forward(id)))
  ipcMain.handle(IPC.tabReload, (_, id: string) => wrap(() => tabs.reload(id)))
  ipcMain.handle(IPC.tabSetMobile, (_, id: string, mobile: boolean) =>
    wrap(() => tabs.setMobile(id, mobile))
  )
  ipcMain.handle(IPC.layoutSet, (_, l: Layout) => wrap(() => tabs.setLayout(l)))

  ipcMain.handle(IPC.agentRun, (_, prompt: string) => wrap(() => agent.run(prompt)))
  ipcMain.handle(IPC.agentStop, () => wrap(() => agent.stop()))
  ipcMain.on(IPC.agentConfirmReply, (_, requestId: string, approved: boolean) =>
    agent.resolveConfirm(requestId, approved)
  )

  ipcMain.handle(IPC.settingsGet, () => wrap(() => settings.get()))
  ipcMain.handle(IPC.settingsSet, (_, patch: Partial<Settings>) => wrap(() => settings.set(patch)))

  return { settings, agent }
}
