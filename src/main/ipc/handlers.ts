import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import * as os from 'node:os'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import { defaultTabUrl } from '../../shared/settings'
import type { TabManager } from '../browser/tab-manager'
import { SettingsStore } from '../settings/store'
import { setOcrEnabled } from '../agent/tools-ocr'
import { AgentRunner } from '../agent/runner'
import type { Db } from '../db/client'
import { VaultService, type PutItemInput, type UpsertAccountInput } from '../vault/service'
import { exportVault, writeOwnerOnlyFile, type ExportRequest } from '../vault/export'
import { ImportService, type ImportDialogs } from '../import/service'
import { VaultCaptureGate } from './vault-capture'
import { watchLoginSuccess } from './login-watch'
import { VaultPickerGate } from './vault-picker'
import { autofillAccount, type AutofillDeps } from '../vault/autofill'
import { assertFromRenderer, isFromRenderer, settingsForSender } from './sender'
import { normalizeHost } from '../../shared/host'
import { isAllowedExternalUrl, isInternalUrl } from '../../shared/url'
import { SyncEngineHolder } from '../sync/engine'
import { toolbarBookmarks } from '../bookmarks/newtab'
import type { NewTabInitDto } from '../../shared/newtab'
// === AI 연결(2b 추가분) ===============================================================
import { isAiProviderId, isApiKeyVendor, isTaskModelKey } from '../../shared/ai'
import type { AiProviderId, ApiKeyVendor, TaskModelKey } from '../../shared/ai'
import { ApiKeyStore } from '../ai/keys'
import { defaultProbes, detectProviders, testApiKey } from '../ai/providers'
import { remapOnProviderChange, taskModelChoices } from '../ai/models'
import { setApiKeyResolver } from '../agent/provider'
// === AI 연결 끝 =======================================================================
import { AuthService } from '../sync/auth'
import { hasSupabaseEnv } from '../sync/env'
import { createSessionStore } from '../sync/session-store'
import { createSupabaseBackend } from '../sync/supabase-backend'
import { SyncConnection, workspaceRemoteId } from '../sync/connect'
import type { DeviceService } from '../sync/devices'
import { WorkspaceService } from '../workspace/service'
import { workspaceShortcutIndex } from '../workspace/shortcut'
import { ExtensionManager, createSessionExtensionHost } from '../extensions/manager'

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
): {
  settings: SettingsStore
  agent: AgentRunner
  db: Db
  vault: VaultService
  auth: AuthService
  sync: SyncEngineHolder
} {
  const settings = new SettingsStore()
  // 동기화 엔진이 붙을 자리. 로그인 전에도 IPC 가 상태를 답할 수 있게 한다
  const sync = new SyncEngineHolder()
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

  // --- 발신자 검증 ---------------------------------------------------------
  // 렌더러 창(메인 UI)에서 온 요청만 허용한다. 탭 안의 웹 페이지 preload 는 별도 게이트
  // (VaultCaptureGate·VaultPickerGate·newTabSender)를 가진 채널만 쓸 수 있다.
  // 판정 자체는 ipc/sender.ts 의 순수 함수에 있다
  /** 렌더러 전용 invoke 채널을 등록한다(발신자 검증 + {ok,data} 포장) */
  function handleFromRenderer<A extends unknown[], T>(
    channel: string,
    fn: (...args: A) => T | Promise<T>
  ): void {
    ipcMain.handle(channel, (e, ...args: unknown[]) =>
      wrap(() => {
        assertFromRenderer(win, e.sender)
        return fn(...(args as A))
      })
    )
  }

  /** 렌더러 전용 단방향(send) 채널을 등록한다. 다른 발신자의 메시지는 조용히 버린다 */
  function onFromRenderer<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      if (!isFromRenderer(win, e.sender)) return
      fn(...(args as A))
    })
  }

  tabs.onChange((list) => send(IPC.tabUpdated, list))

  // 창이 닫히면 등록한 핸들러를 모두 걷어낸다(1단계는 단일 창)
  win.once('closed', () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners(IPC.agentConfirmReply)
    ipcMain.removeAllListeners(IPC.vaultCaptureDecision)
    ipcMain.removeAllListeners(IPC.vaultCapture)
    ipcMain.removeAllListeners(IPC.vaultUndoPasswordUpdate)
    sync.current()?.stop()
    sync.release()
    vault.dispose()
  })

  handleFromRenderer(IPC.tabList, () => tabs.list())
  handleFromRenderer(IPC.tabCreate, (o: { url?: string; profile?: string; mobile?: boolean }) =>
    tabs.create(o)
  )
  handleFromRenderer(IPC.tabClose, (id: string) => tabs.close(id))
  handleFromRenderer(IPC.tabActivate, (id: string) => tabs.activate(id))
  handleFromRenderer(IPC.tabNavigate, (id: string, url: string) => tabs.navigate(id, url))
  handleFromRenderer(IPC.tabBack, (id: string) => tabs.back(id))
  handleFromRenderer(IPC.tabForward, (id: string) => tabs.forward(id))
  handleFromRenderer(IPC.tabReload, (id: string) => tabs.reload(id))
  handleFromRenderer(IPC.tabSetMobile, (id: string, mobile: boolean) => tabs.setMobile(id, mobile))
  handleFromRenderer(IPC.layoutSet, (l: Layout) => tabs.setLayout(l))

  // 실행 시작만 즉시 확인해 주고, 완료·실패는 status 이벤트로만 알린다.
  // (예전처럼 완료까지 기다리면 늦게 끝난 이전 작업의 응답이 새 작업 UI 를 덮어썼다)
  handleFromRenderer(IPC.agentRun, (prompt: string) => {
    void agent.run(prompt).catch((e: unknown) => console.error('작업 실행 실패', e))
    return { started: true }
  })
  handleFromRenderer(IPC.agentStop, () => agent.stop())
  onFromRenderer(IPC.agentConfirmReply, (requestId: string, approved: boolean) =>
    agent.resolveConfirm(requestId, approved)
  )

  // 렌더러 창(메인 UI)에는 전체 설정을, 탭 안의 페이지 preload(언어 표기용)에는
  // language 하나만 돌려준다. 분기 로직 자체는 sender.ts 의 순수 함수(settingsForSender)에 있다
  ipcMain.handle(IPC.settingsGet, (e) =>
    wrap(() => settingsForSender(settings.get(), win, e.sender))
  )
  handleFromRenderer(IPC.settingsSet, (patch: Partial<Settings>) => {
    const s = settings.set(patch)
    // 홈 주소·새 탭 주소·검색엔진이 바뀌면 tab-manager 도 즉시 반영한다
    applyBrowserDefaults(s)
    setOcrEnabled(s.ocrEnabled)
    return s
  })

  // --- 금고 ---------------------------------------------------------------
  // 비밀값(평문)을 돌려주는 채널은 vault:reveal 하나뿐이다. 나머지는 전부 메타/상태만 보낸다.
  handleFromRenderer(IPC.vaultState, () => vault.state())
  handleFromRenderer(IPC.vaultSetup, (master: string) => vault.setup(master))
  handleFromRenderer(IPC.vaultUnlock, (master: string) => vault.unlock(master))
  handleFromRenderer(IPC.vaultLock, () => vault.lock())
  // 복구 키 — 발급 응답만 평문을 돌려주고, 확인을 통과해야 감싼 키가 저장된다
  handleFromRenderer(IPC.vaultRecoveryCreate, () => vault.createRecoveryKey())
  handleFromRenderer(IPC.vaultRecoveryConfirm, (input: string) => vault.confirmRecoveryKey(input))
  handleFromRenderer(IPC.vaultRecoveryUnlock, (input: string) => vault.unlockWithRecoveryKey(input))
  handleFromRenderer(IPC.vaultSites, () => {
    vault.touch()
    return vault.listSites()
  })
  handleFromRenderer(IPC.vaultAccounts, (host?: string) => {
    vault.touch()
    return vault.listAccounts(host)
  })
  handleFromRenderer(IPC.vaultItems, (accountId: number | null) => {
    vault.touch()
    return vault.listItems(accountId ?? null)
  })
  handleFromRenderer(IPC.vaultPutItem, (input: PutItemInput) => vault.putItem(input))
  handleFromRenderer(IPC.vaultDeleteItem, (id: number) => vault.deleteItem(id))
  // 사용자가 '보기' 를 눌렀을 때만 호출된다(감사 로그 기록됨)
  handleFromRenderer(IPC.vaultReveal, (id: number, fieldKey?: string) => vault.reveal(id, fieldKey))
  handleFromRenderer(IPC.vaultDeleteAccounts, (ids: number[]) =>
    vault.deleteAccounts(Array.isArray(ids) ? ids : [])
  )
  handleFromRenderer(IPC.vaultUndoDelete, (token: string) => vault.undoDeleteAccounts(token))
  handleFromRenderer(IPC.vaultUpsertAccount, (dto: UpsertAccountInput) => vault.upsertAccount(dto))
  // 사용 기록(감사 로그). accountId 를 주면 그 계정 소유 항목만, 아니면 전체를 반환한다
  handleFromRenderer(IPC.vaultAudit, (accountId?: number, limit?: number) =>
    vault.listAudit(accountId, limit)
  )
  // 내보내기 — 평문은 사용자가 고른 파일에만 들어가고, 응답에는 개수·경로만 담긴다
  handleFromRenderer(IPC.vaultExport, (req: ExportRequest) =>
    exportVault(
      {
        vault,
        showSaveDialog: async (prompt) => {
          const result = await dialog.showSaveDialog(win, {
            defaultPath: prompt.defaultPath,
            filters: prompt.filters,
            message: prompt.message,
            nameFieldLabel: prompt.nameFieldLabel
          })
          if (result.canceled || !result.filePath) return undefined
          return result.filePath
        },
        // 평문이 담기는 파일이다 — 소유자만 읽을 수 있게 한다(0o600)
        writeFile: (filePath, content) => writeOwnerOnlyFile(filePath, content)
      },
      req
    )
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
  onFromRenderer(IPC.vaultUndoPasswordUpdate, (token: string) => {
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
  handleFromRenderer(IPC.vaultAutofill, (accountId: number) =>
    autofillAccount(autofillDeps, accountId)
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
  onFromRenderer(IPC.vaultCaptureDecision, (accept: boolean) => {
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
  handleFromRenderer(IPC.importPasswords, (filePath?: string) =>
    importService.importPasswords(filePath)
  )
  handleFromRenderer(IPC.importBookmarks, (filePath?: string) =>
    importService.importBookmarks(filePath)
  )
  handleFromRenderer(IPC.bookmarksTree, () => importService.tree())
  handleFromRenderer(IPC.bookmarksRemove, (id: number) => importService.removeBookmark(id))

  // === 북마크 관리자 페이지 (신규 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) =========
  handleFromRenderer(IPC.bookmarksCreateFolder, (o: { parentId: number | null; name: string }) =>
    importService.createBookmarkFolder(o.parentId, o.name)
  )
  handleFromRenderer(
    IPC.bookmarksCreateLink,
    (o: { folderId: number | null; title: string; url: string }) =>
      importService.createBookmarkLink(o.folderId, o.title, o.url)
  )
  handleFromRenderer(
    IPC.bookmarksRename,
    (o: { id: number; kind: 'folder' | 'link'; name: string }) =>
      importService.renameBookmark(o.id, o.kind, o.name)
  )
  handleFromRenderer(
    IPC.bookmarksMove,
    (o: { id: number; kind: 'folder' | 'link'; toFolderId: number | null }) =>
      importService.moveBookmark(o.id, o.kind, o.toFolderId)
  )
  handleFromRenderer(IPC.bookmarksRemoveFolder, (id: number) =>
    importService.removeBookmarkFolder(id)
  )
  handleFromRenderer(IPC.bookmarksSort, (o: { folderId: number | null; by: 'name' }) =>
    importService.sortBookmarkFolder(o.folderId)
  )
  handleFromRenderer(IPC.bookmarksExport, () => importService.exportBookmarks())
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

  // === AI 연결(2b 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) ======================
  // 평문 API 키는 이 저장소와 agent/provider.ts 안에만 머문다. 렌더러로 나가는 것은
  // 마스킹 문자열(sk-ant-••••1234)과 boolean 뿐이다
  const apiKeys = new ApiKeyStore(join(app.getPath('userData'), 'ai-keys.bin'), safeStorage)
  const aiProbes = defaultProbes()
  // ApiKeyStore.get 의 유일한 소비자(agent/provider.ts)에 조회기를 심는다.
  // '내 API 키' 경로를 고른 경우에만 키를 넘긴다
  setApiKeyResolver(() =>
    settings.get().aiProvider === 'api_key' ? apiKeys.get('anthropic') : null
  )
  win.once('closed', () => setApiKeyResolver(null))

  handleFromRenderer(IPC.aiProviders, () => detectProviders(aiProbes, apiKeys.masked()))
  handleFromRenderer(IPC.aiSetProvider, (raw: unknown) => {
    if (!isAiProviderId(raw)) throw new Error('알 수 없는 AI 연결 경로')
    const before = settings.get()
    const { models, changed } = remapOnProviderChange(
      before.taskModels,
      before.aiProvider as AiProviderId,
      raw
    )
    const after = settings.set({ aiProvider: raw, taskModels: models })
    return { provider: after.aiProvider, taskModels: after.taskModels, changed }
  })
  // 평문 키는 렌더러 → 메인 한 방향으로만 흐른다. 응답은 마스킹뿐이다
  handleFromRenderer(IPC.aiSetApiKey, (rawVendor: unknown, rawKey: unknown) => {
    if (!isApiKeyVendor(rawVendor)) throw new Error('알 수 없는 API 키 제공자')
    const key = typeof rawKey === 'string' ? rawKey : ''
    if (key.trim()) apiKeys.set(rawVendor as ApiKeyVendor, key)
    else apiKeys.remove(rawVendor as ApiKeyVendor)
    return apiKeys.masked()
  })
  // 확인은 모델 목록 1회 호출. 응답 본문은 읽지도 로그에 남기지도 않는다
  handleFromRenderer(IPC.aiTestKey, async (rawVendor: unknown, rawKey: unknown) => {
    if (!isApiKeyVendor(rawVendor)) throw new Error('알 수 없는 API 키 제공자')
    const key = typeof rawKey === 'string' ? rawKey : ''
    return testApiKey(rawVendor as ApiKeyVendor, key)
  })
  handleFromRenderer(IPC.aiTaskModels, () => {
    const s = settings.get()
    return {
      provider: s.aiProvider,
      taskModels: s.taskModels,
      choices: taskModelChoices(s.aiProvider as AiProviderId)
    }
  })
  handleFromRenderer(IPC.aiSetTaskModel, (rawKey: unknown, rawModel: unknown) => {
    if (!isTaskModelKey(rawKey)) throw new Error('알 수 없는 작업 등급')
    if (typeof rawModel !== 'string' || !rawModel.trim()) throw new Error('모델 이름이 비어 있음')
    const key = rawKey as TaskModelKey
    const next = { ...settings.get().taskModels, [key]: rawModel.trim() }
    return settings.set({ taskModels: next }).taskModels
  })
  // === AI 연결 끝 =======================================================================

  // === 계정 인증(2b) ===================================================================
  // .env 가 비어 있으면 백엔드를 아예 만들지 않는다(설정 전에도 앱은 그대로 돈다).
  // refresh token 은 safeStorage 로 감싼 파일에만 남고 렌더러로는 나가지 않는다
  const syncConfigured = hasSupabaseEnv()
  const sessionStore = createSessionStore(
    join(app.getPath('userData'), 'sync-session.bin'),
    safeStorage
  )
  const syncBackend = syncConfigured ? createSupabaseBackend(sessionStore) : null
  const auth = new AuthService({
    backend: syncBackend,
    configured: syncConfigured,
    openExternal: (url) => shell.openExternal(url)
  })
  auth.onStateChanged((state) => send(IPC.authStateChanged, state))
  // 구글 로그인을 기다리는 중에 창이 닫히면 루프백 서버가 최대 5분 남는다
  win.once('closed', () => auth.dispose())
  // 저장된 세션이 있으면 조용히 되살린다(실패는 로그아웃으로 본다)
  void auth.restore()

  handleFromRenderer(IPC.authState, () => auth.state())
  handleFromRenderer(IPC.authSignUp, (email: string, password: string) =>
    auth.signUp(email, password)
  )
  handleFromRenderer(IPC.authSignIn, (email: string, password: string) =>
    auth.signIn(email, password)
  )
  // 브라우저에서 구글 로그인을 마칠 때까지(최대 5분) 응답이 늦게 온다
  handleFromRenderer(IPC.authSignInGoogle, () => auth.signInGoogle())
  handleFromRenderer(IPC.authSignOut, () => auth.signOut())
  // === 계정 인증 끝 ====================================================================

  // === 작업공간(브라우저 프로필) — 이 블록만 따로 추가한다 =============================
  const workspace = new WorkspaceService(db, settings)
  // 첫 실행이면 '기본' 작업공간을 만들고, 저장소·탭 파티션을 현재 작업공간에 맞춘다
  const applyWorkspace = (notify: boolean): void => {
    const current = workspace.ensureDefault()
    const scope = workspace.scope()
    vault.setWorkspaceScope(scope)
    importService.setWorkspaceScope(scope)
    // 열려 있는 탭의 세션은 그대로 두고, 새로 여는 탭부터 새 파티션을 쓴다
    tabs.setPartitionPrefix(workspace.partitionPrefix())
    if (notify) send(IPC.workspaceChanged, current)
  }
  applyWorkspace(false)
  workspace.onChanged(() => applyWorkspace(true))

  // Ctrl+Alt+1~9 — 전역 단축키가 아니라 이 창(렌더러 UI + 탭 페이지)에서만 듣는다
  const handleWorkspaceShortcut = (input: {
    type: string
    key: string
    control: boolean
    alt: boolean
    shift: boolean
    meta: boolean
  }): boolean => {
    const index = workspaceShortcutIndex(input)
    if (index === null) return false
    try {
      return workspace.switchToIndex(index) !== null
    } catch (e) {
      console.error('작업공간 전환 실패', e)
      return false
    }
  }
  win.webContents.on('before-input-event', (e, input) => {
    if (handleWorkspaceShortcut(input)) e.preventDefault()
  })
  tabs.setInputHandler(handleWorkspaceShortcut)

  handleFromRenderer(IPC.workspaceList, () => workspace.list())
  handleFromRenderer(IPC.workspaceCreate, (o: { name: string; color?: string }) =>
    workspace.create(o.name, o.color)
  )
  handleFromRenderer(IPC.workspaceSwitch, (id: number) => workspace.switchTo(id))
  handleFromRenderer(IPC.workspaceRename, (o: { id: number; name: string }) =>
    workspace.rename(o.id, o.name)
  )
  handleFromRenderer(IPC.workspaceDelete, (id: number) => workspace.remove(id))
  // === 작업공간 끝 =====================================================================

  // === 동기화(2b) ======================================================================
  // 엔진은 로그인 이후에 만들어져 holder 에 붙는다. 붙기 전에는 오프라인 상태를 답한다
  handleFromRenderer(IPC.syncStatus, () => sync.status())
  handleFromRenderer(IPC.syncNow, () => sync.syncNow())
  sync.onStatusChanged((status) => send(IPC.syncStatusChanged, status))
  // 로그인하면 이 PC 를 기기 목록에 올리고, 저장소에 변경 로그 훅을 붙인 뒤 엔진을 돌린다.
  // 로그아웃·토큰 만료·기기 원격 로그아웃은 모두 같은 정리 경로(엔진 정지·훅 해제·금고 잠금)를 탄다
  const connection = new SyncConnection({
    db,
    backend: syncBackend,
    auth,
    holder: sync,
    vault,
    settings,
    bookmarks: importService,
    // 주기마다 다시 불린다 — 작업공간을 바꿔도 다음 주기부터 새 uuid 로 올라간다
    workspace: () => {
      const localId = workspace.activeId()
      return { localId, remoteId: workspaceRemoteId(db, localId) }
    },
    device: {
      hostname: () => os.hostname(),
      osLabel: () => `${os.type()} ${os.release()}`,
      appVersion: () => app.getVersion()
    }
  })
  // 세션 복구가 이 시점보다 먼저 끝났을 수 있다 — 지금 상태를 한 번 반영한다
  void connection.refresh()
  win.once('closed', () => connection.dispose())

  const requireDevices = (): DeviceService => {
    const devices = connection.devices()
    if (!devices) throw new Error('로그인이 필요합니다')
    return devices
  }
  handleFromRenderer(IPC.devicesList, () => requireDevices().list())
  handleFromRenderer(IPC.devicesRevoke, (deviceId: string) => requireDevices().revoke(deviceId))
  // === 동기화 끝 =======================================================================

  // === 확장(압축 해제된 크롬 확장 폴더) — 이 블록만 따로 추가한다 ======================
  // 기본 세션에 걸고, 작업공간 파티션 세션이 새로 생기면 같은 확장을 그 세션에도 건다.
  // 로드 실패는 항목별 오류 문자열로만 남고 앱을 멈추지 않는다
  const extensions = new ExtensionManager(
    createSessionExtensionHost(session.defaultSession),
    settings
  )
  void extensions.loadSaved().catch((e: unknown) => console.error('저장된 확장 로드 실패', e))
  tabs.setSessionHook((ses) => {
    void extensions
      .attachHost(createSessionExtensionHost(ses))
      .catch((e: unknown) => console.error('파티션 세션 확장 로드 실패', e))
  })

  handleFromRenderer(IPC.extList, () => ({ items: extensions.list(), errors: extensions.errors() }))
  // 경로를 주지 않으면 폴더 선택 다이얼로그를 연다. 취소하면 null 을 돌려준다.
  // 렌더러가 준 경로든 다이얼로그로 고른 경로든 resolveExtensionFolder 를 반드시 지난다 —
  // realpath 로 푼 실제 디렉터리이고 manifest.json 검증을 통과해야만 세션에 넘어간다
  handleFromRenderer(IPC.extLoad, async (rawPath?: unknown) => {
    let folder = typeof rawPath === 'string' ? rawPath : ''
    if (!folder) {
      const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return null
      folder = picked.filePaths[0]
    }
    return extensions.add(folder)
  })
  handleFromRenderer(IPC.extRemove, (id: string) => extensions.remove(id))
  // === 확장 끝 =========================================================================

  return { settings, agent, db, vault, auth, sync }
}
