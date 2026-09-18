import { dialog, ipcMain, safeStorage, type BrowserWindow, type WebContents } from 'electron'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import { defaultTabUrl } from '../../shared/settings'
import type { TabManager } from '../browser/tab-manager'
import { SettingsStore } from '../settings/store'
import { setOcrEnabled } from '../agent/tools-ocr'
import { AgentRunner } from '../agent/runner'
import type { Db } from '../db/client'
import { VaultService, type PutItemInput, type UpsertAccountInput } from '../vault/service'
import { ImportService, type ImportDialogs } from '../import/service'
import { VaultCaptureGate } from './vault-capture'
import { watchLoginSuccess } from './login-watch'
import { VaultPickerGate } from './vault-picker'
import { autofillAccount, type AutofillDeps } from '../vault/autofill'
import { normalizeHost } from '../../shared/host'
import { isAllowedExternalUrl, isInternalUrl } from '../../shared/url'
import { toolbarBookmarks } from '../bookmarks/newtab'
import type { NewTabInitDto } from '../../shared/newtab'

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
  // === 홈 버튼 / 설정 페이지 (신규 추가분) ===================================
  // newTabUrl(홈과 동일/빈 페이지) + homeUrl 을 조합해 tab-manager 가 쓸 최종
  // 기본 주소를 계산한다. tab-manager 는 이 enum 을 몰라도 되게 분리했다
  const applyBrowserDefaults = (s: Settings): void => {
    tabs.setDefaultUrl(defaultTabUrl(s))
    tabs.setSearchEngine(s.searchEngine)
  }
  applyBrowserDefaults(settings.get())
  setOcrEnabled(settings.get().ocrEnabled)
  // === 신규 추가분 끝 =========================================================
  // 창이 이미 파괴됐는데 send 하면 예외가 난다. 모든 main→renderer 통지는 이 관문을 거친다
  const send = (channel: string, payload: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  // 금고. 마스터 키는 이 인스턴스 안에만 있고 IPC 로는 절대 나가지 않는다
  const vault = new VaultService(db, settings, { safeStorage })
  // AI 도구(list_accounts/fill_secret/login)가 쓸 수 있도록 금고를 넘긴다
  const agent = new AgentRunner(tabs, settings, (ev) => send(IPC.agentEvent, ev), vault)
  // 페이지 JS 대화상자는 AI 작업이 도는 동안에만 자동 처리한다
  tabs.setAgentRunningProvider(() => agent.isRunning())
  // guard 모드에서 confirm/beforeunload 는 사용자 확인 카드를 거쳐야 '예' 가 된다
  tabs.setDialogPolicy({
    mode: () => settings.get().permissionMode,
    confirm: (message) => agent.requestConfirm(`페이지 확인: ${message}`, 'danger')
  })
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
  // === 북마크 관리자 페이지 (신규 추가분) — 내보내기용 저장 다이얼로그를 나중에 덧붙인다 ===
  // (importDialogs 리터럴 자체는 건드리지 않고, 참조가 같은 객체에 속성만 추가한다)
  importDialogs.showSaveDialog = async (filters, defaultPath) => {
    const result = await dialog.showSaveDialog(win, { filters, defaultPath })
    if (result.canceled || !result.filePath) return undefined
    return result.filePath
  }
  // === 북마크 관리자 페이지 끝 ===========================================================

  tabs.onChange((list) => send(IPC.tabUpdated, list))

  // 창이 닫히면 등록한 핸들러를 모두 걷어낸다(1단계는 단일 창)
  win.once('closed', () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners(IPC.agentConfirmReply)
    ipcMain.removeAllListeners(IPC.vaultCaptureDecision)
    ipcMain.removeAllListeners(IPC.vaultCapture)
    ipcMain.removeAllListeners(IPC.vaultUndoPasswordUpdate)
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
  ipcMain.handle(IPC.settingsSet, (_, patch: Partial<Settings>) =>
    wrap(() => {
      const s = settings.set(patch)
      // 홈 주소·새 탭 주소·검색엔진이 바뀌면 tab-manager 도 즉시 반영한다
      applyBrowserDefaults(s)
      setOcrEnabled(s.ocrEnabled)
      return s
    })
  )

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
  ipcMain.handle(IPC.vaultReveal, (_, id: number, fieldKey?: string) =>
    wrap(() => vault.reveal(id, fieldKey))
  )
  ipcMain.handle(IPC.vaultDeleteAccounts, (_, ids: number[]) =>
    wrap(() => vault.deleteAccounts(Array.isArray(ids) ? ids : []))
  )
  ipcMain.handle(IPC.vaultUndoDelete, (_, token: string) =>
    wrap(() => vault.undoDeleteAccounts(token))
  )
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
    excludedHosts: () => settings.get().vaultExcludedHosts,
    // 기존 계정 + 다른 값으로 로그인 폼이 제출되면(자동 갱신이 켜져 있을 때) 저장 제안 없이
    // navigation 을 지켜보다가 로그인 성공을 감지했을 때만 조용히 갱신한다
    autoUpdateEnabled: () => settings.get().vaultAutoUpdatePassword,
    onPendingUpdate: (payload, senderKey) => {
      const wc = senderKey as WebContents
      watchLoginSuccess(wc, wc.getURL(), payload, vault, (result) =>
        send(IPC.vaultPasswordUpdated, result)
      )
    }
  })
  ipcMain.on(IPC.vaultCapture, (e, raw: unknown) => {
    captureGate.handle(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      raw
    )
  })

  // 자동 갱신 되돌리기(60초 이내). 실패해도 조용히 무시한다(토큰 만료 등)
  ipcMain.on(IPC.vaultUndoPasswordUpdate, (_, token: string) => {
    try {
      vault.undoAutoPasswordUpdate(token)
    } catch (e: unknown) {
      console.error('비밀번호 되돌리기 실패', e instanceof Error ? e.message : String(e))
    }
  })

  // 자동 채움(사용자 조작) — 값은 메인 안에서만 오간다.
  // 상세 화면의 '자동 채우기' 버튼과 페이지 내 피커가 같은 경로를 쓴다
  const autofillDeps: AutofillDeps = {
    vault,
    activeTab: () => tabs.active(),
    excludedHosts: () => settings.get().vaultExcludedHosts
  }
  ipcMain.handle(IPC.vaultAutofill, (_, accountId: number) =>
    wrap(() => autofillAccount(autofillDeps, accountId))
  )

  // 페이지 내 자동 채움 피커. 목록은 {id,label,username} 뿐이고, 값은 메인이 직접 채운다
  const pickerGate = new VaultPickerGate({
    vault,
    excludedHosts: () => settings.get().vaultExcludedHosts
  })
  ipcMain.handle(IPC.vaultPickerAccounts, (e, rawHost: unknown) => {
    const result = pickerGate.accounts(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      rawHost
    )
    return { outcome: result.outcome, accounts: result.accounts }
  })
  // 피커 채우기는 활성 탭이 아니라 "요청을 보낸 탭"에, 게이트가 검증한 호스트로만 채운다.
  // 결과는 호출한 페이지(격리 월드)로 돌려줘 실패를 조용히 삼키지 않는다
  ipcMain.handle(IPC.vaultPickerFill, async (e, raw: unknown) => {
    const result = pickerGate.fill(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      raw
    )
    if (result.outcome !== 'ok' || result.accountId === undefined || result.host === undefined) {
      return { outcome: result.outcome }
    }
    const tab = tabs.findByWebContents(e.sender)
    if (!tab) return { outcome: 'untrusted-sender' }
    try {
      const filled = await autofillAccount(autofillDeps, result.accountId, {
        tab,
        host: result.host
      })
      return { outcome: filled }
    } catch (err: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('피커 자동 채움 실패', err instanceof Error ? err.message : String(err))
      return { outcome: 'fill-failed' }
    }
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
        type: 'login',
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

  // === 북마크 관리자 페이지 (신규 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) =========
  ipcMain.handle(IPC.bookmarksCreateFolder, (_, o: { parentId: number | null; name: string }) =>
    wrap(() => importService.createBookmarkFolder(o.parentId, o.name))
  )
  ipcMain.handle(
    IPC.bookmarksCreateLink,
    (_, o: { folderId: number | null; title: string; url: string }) =>
      wrap(() => importService.createBookmarkLink(o.folderId, o.title, o.url))
  )
  ipcMain.handle(
    IPC.bookmarksRename,
    (_, o: { id: number; kind: 'folder' | 'link'; name: string }) =>
      wrap(() => importService.renameBookmark(o.id, o.kind, o.name))
  )
  ipcMain.handle(
    IPC.bookmarksMove,
    (_, o: { id: number; kind: 'folder' | 'link'; toFolderId: number | null }) =>
      wrap(() => importService.moveBookmark(o.id, o.kind, o.toFolderId))
  )
  ipcMain.handle(IPC.bookmarksRemoveFolder, (_, id: number) =>
    wrap(() => importService.removeBookmarkFolder(id))
  )
  ipcMain.handle(IPC.bookmarksSort, (_, o: { folderId: number | null; by: 'name' }) =>
    wrap(() => importService.sortBookmarkFolder(o.folderId))
  )
  ipcMain.handle(IPC.bookmarksExport, () => wrap(() => importService.exportBookmarks()))
  // === 북마크 관리자 페이지 끝 ===========================================================

  // === 자체 새 탭 페이지(samba://newtab) ================================================
  // 발신자는 반드시 관리 중인 탭이면서 내부 페이지여야 한다(웹 페이지의 위조 호출 차단)
  const newTabSender = (sender: WebContents): { tabId: string } | null => {
    const tab = tabs.findByWebContents(sender)
    if (!tab) return null
    if (!isInternalUrl(sender.getURL())) return null
    return { tabId: tab.id }
  }

  ipcMain.handle(IPC.newTabInit, (e): NewTabInitDto => {
    if (!newTabSender(e.sender)) return { language: settings.get().language, bookmarks: [] }
    return {
      language: settings.get().language,
      bookmarks: toolbarBookmarks(importService.tree())
    }
  })

  ipcMain.on(IPC.newTabSearch, (e, input: unknown) => {
    const from = newTabSender(e.sender)
    if (!from || typeof input !== 'string' || !input.trim()) return
    // 검색어 → URL 변환과 허용 판정은 주소창과 완전히 같은 경로를 쓴다
    void tabs.navigate(from.tabId, input).catch((err: unknown) => {
      console.warn('새 탭 검색 실패', err instanceof Error ? err.message : String(err))
    })
  })

  ipcMain.on(IPC.newTabOpen, (e, url: unknown) => {
    const from = newTabSender(e.sender)
    if (!from || typeof url !== 'string' || !isAllowedExternalUrl(url)) return
    void tabs.navigate(from.tabId, url).catch((err: unknown) => {
      console.warn('새 탭 북마크 열기 실패', err instanceof Error ? err.message : String(err))
    })
  })
  // === 자체 새 탭 페이지 끝 =============================================================

  return { settings, agent, db, vault }
}
