import { dialog, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import type { TabManager } from '../browser/tab-manager'
import { SettingsStore } from '../settings/store'
import { AgentRunner } from '../agent/runner'
import type { Db } from '../db/client'
import { VaultService, type PutItemInput, type UpsertAccountInput } from '../vault/service'
import { ImportService, type ImportDialogs } from '../import/service'
import { VaultCaptureGate } from './vault-capture'
import { normalizeHost } from '../../shared/host'

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
  tabs: TabManager,
  db: Db
): { settings: SettingsStore; agent: AgentRunner; db: Db; vault: VaultService } {
  const settings = new SettingsStore()
  // 창이 이미 파괴됐는데 send 하면 예외가 난다. 모든 main→renderer 통지는 이 관문을 거친다
  const send = (channel: string, payload: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  // 금고. 마스터 키는 이 인스턴스 안에만 있고 IPC 로는 절대 나가지 않는다
  const vault = new VaultService(db, settings, { safeStorage })
  // AI 도구(list_accounts/fill_secret/login)가 쓸 수 있도록 금고를 넘긴다
  const agent = new AgentRunner(tabs, settings, (ev) => send(IPC.agentEvent, ev), vault)
  vault.onStateChanged((state) => send(IPC.vaultStateChanged, state))
  // 저장 제안 카드에는 host/username/isNew 만 간다(비밀번호는 메인에 남는다)
  vault.onCapturePrompt((prompt) => send(IPC.vaultCapturePrompt, prompt))

  // 가져오기(비밀번호 CSV·북마크 HTML). filePath 를 안 주면 다이얼로그를 연다
  const importDialogs: ImportDialogs = {
    showOpenDialog: async (filters) => {
      const result = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] })
      if (result.canceled || result.filePaths.length === 0) return undefined
      return result.filePaths[0]
    }
  }
  const importService = new ImportService(db, vault, importDialogs)

  tabs.onChange((list) => send(IPC.tabUpdated, list))

  // 창이 닫히면 등록한 핸들러를 모두 걷어낸다(1단계는 단일 창)
  win.once('closed', () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners(IPC.agentConfirmReply)
    ipcMain.removeAllListeners(IPC.vaultCaptureDecision)
    ipcMain.removeAllListeners(IPC.vaultCapture)
    vault.dispose()
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

  // --- 금고 ---------------------------------------------------------------
  // 비밀값(평문)을 돌려주는 채널은 vault:reveal 하나뿐이다. 나머지는 전부 메타/상태만 보낸다.
  ipcMain.handle(IPC.vaultState, () => wrap(() => vault.state()))
  ipcMain.handle(IPC.vaultSetup, (_, master: string) => wrap(() => vault.setup(master)))
  ipcMain.handle(IPC.vaultUnlock, (_, master: string) => wrap(() => vault.unlock(master)))
  ipcMain.handle(IPC.vaultLock, () => wrap(() => vault.lock()))
  ipcMain.handle(IPC.vaultSites, () =>
    wrap(() => {
      vault.touch()
      return vault.listSites()
    })
  )
  ipcMain.handle(IPC.vaultAccounts, (_, host?: string) =>
    wrap(() => {
      vault.touch()
      return vault.listAccounts(host)
    })
  )
  ipcMain.handle(IPC.vaultItems, (_, accountId: number | null) =>
    wrap(() => {
      vault.touch()
      return vault.listItems(accountId ?? null)
    })
  )
  ipcMain.handle(IPC.vaultPutItem, (_, input: PutItemInput) => wrap(() => vault.putItem(input)))
  ipcMain.handle(IPC.vaultDeleteItem, (_, id: number) => wrap(() => vault.deleteItem(id)))
  // 사용자가 '보기' 를 눌렀을 때만 호출된다(감사 로그 기록됨)
  ipcMain.handle(IPC.vaultReveal, (_, id: number) => wrap(() => vault.reveal(id)))
  ipcMain.handle(IPC.vaultUpsertAccount, (_, dto: UpsertAccountInput) =>
    wrap(() => vault.upsertAccount(dto))
  )
  // 사용 기록(감사 로그). accountId 를 주면 그 계정 소유 항목만, 아니면 전체를 반환한다
  ipcMain.handle(IPC.vaultAudit, (_, accountId?: number, limit?: number) =>
    wrap(() => vault.listAudit(accountId, limit))
  )
  // 페이지(preload 격리 월드)가 감지한 로그인 폼 제출.
  // 검증·레이트리밋·호스트 대조는 전부 VaultCaptureGate 안에 있다(테스트 가능하도록 분리)
  const captureGate = new VaultCaptureGate({
    vault,
    excludedHosts: () => settings.get().vaultExcludedHosts
  })
  ipcMain.on(IPC.vaultCapture, (e, raw: unknown) => {
    captureGate.handle(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      raw
    )
  })

  // 저장 제안 수락/거절. 거절이면 보관 중이던 비밀번호를 그냥 버린다
  ipcMain.on(IPC.vaultCaptureDecision, (_, accept: boolean) => {
    const capture = vault.takePendingCapture()
    if (!accept || !capture) return
    // 수락했는데 그 사이 금고가 잠겼다면(자동 잠금 등) 조용히 버리지 않고 제안을 다시 띄운다.
    // 사용자가 카드에서 잠금을 풀고 다시 저장할 수 있다
    if (vault.state() !== 'unlocked') {
      vault.setPendingCapture({ ...capture, locked: true })
      return
    }
    try {
      const host = normalizeHost(capture.host) || capture.host
      // 기존 계정이면 label/isDefault 를 넘기지 않는다 — 사용자가 붙여 둔 라벨과
      // 기본 계정 지정을 자동 저장이 덮어쓰지 않게 한다
      const existing = vault.listAccounts(host).find((a) => a.username === capture.username)
      const account = vault.upsertAccount({
        id: existing?.id,
        host,
        ...(existing ? {} : { label: host }),
        username: capture.username
      })
      vault.putItem({
        accountId: account.id,
        type: 'login_password',
        label: '로그인 비밀번호',
        value: capture.password
      })
    } catch (e: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('자격정보 저장 실패', e instanceof Error ? e.message : String(e))
    }
  })

  // --- 가져오기 -------------------------------------------------------------
  ipcMain.handle(IPC.importPasswords, (_, filePath?: string) =>
    wrap(() => importService.importPasswords(filePath))
  )
  ipcMain.handle(IPC.importBookmarks, (_, filePath?: string) =>
    wrap(() => importService.importBookmarks(filePath))
  )
  ipcMain.handle(IPC.bookmarksTree, () => wrap(() => importService.tree()))
  ipcMain.handle(IPC.bookmarksRemove, (_, id: number) =>
    wrap(() => importService.removeBookmark(id))
  )

  return { settings, agent, db, vault }
}
