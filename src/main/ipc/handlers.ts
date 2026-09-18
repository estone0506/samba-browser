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
  // 창이 이미 파괴됐는데 send 하면 예외가 난다. 모든 main→renderer 통지는 이 관문을 거친다
  const send = (channel: string, payload: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  const agent = new AgentRunner(tabs, settings, (ev) => send(IPC.agentEvent, ev))

  tabs.onChange((list) => send(IPC.tabUpdated, list))

  // 창이 닫히면 등록한 핸들러를 모두 걷어낸다(1단계는 단일 창)
  win.once('closed', () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners(IPC.agentConfirmReply)
  })

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

  // 실행 시작만 즉시 확인해 주고, 완료·실패는 status 이벤트로만 알린다.
  // (예전처럼 완료까지 기다리면 늦게 끝난 이전 작업의 응답이 새 작업 UI 를 덮어썼다)
  ipcMain.handle(IPC.agentRun, (_, prompt: string) =>
    wrap(() => {
      void agent.run(prompt).catch((e: unknown) => console.error('작업 실행 실패', e))
      return { started: true }
    })
  )
  ipcMain.handle(IPC.agentStop, () => wrap(() => agent.stop()))
  ipcMain.on(IPC.agentConfirmReply, (_, requestId: string, approved: boolean) =>
    agent.resolveConfirm(requestId, approved)
  )

  ipcMain.handle(IPC.settingsGet, () => wrap(() => settings.get()))
  ipcMain.handle(IPC.settingsSet, (_, patch: Partial<Settings>) => wrap(() => settings.set(patch)))

  return { settings, agent }
}
