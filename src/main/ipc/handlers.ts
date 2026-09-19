import {
  app,
  dialog,
  ipcMain,
  net,
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
import { ClosedTabStack, newProfileName, runGesture, type GestureDeps } from '../browser/gestures'
import { SettingsStore } from '../settings/store'
import { setOcrEnabled } from '../agent/tools-ocr'
import { AgentRunner } from '../agent/runner'
import type { Db } from '../db/client'
import { VaultService, type PutItemInput, type UpsertAccountInput } from '../vault/service'
import { exportVault, writeOwnerOnlyFile, type ExportRequest } from '../vault/export'
import { ImportService, type ImportDialogs } from '../import/service'
import { ChatRepo } from '../chat/repo'
import { PlaybookStore } from '../playbooks/store'
import type { PlaybookInput } from '../../shared/playbook'
import { RECENT_CHAT_LIMIT, type AppendMessageInput } from '../../shared/chat'
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
import {
  connectionKeyOf,
  isAiProviderId,
  isApiKeyVendor,
  isSubscriptionProviderId,
  isTaskModelKey
} from '../../shared/ai'
import type { AiProviderId, ApiKeyVendor, TaskModelKey } from '../../shared/ai'
import { ApiKeyStore } from '../ai/keys'
import {
  defaultProbes,
  detectProviders,
  readAccountFromDisk,
  SUBSCRIPTION_CLI,
  testApiKey
} from '../ai/providers'
import {
  connectSubscription,
  disconnectedRecord,
  openLoginTerminal,
  migrateAiConnections,
  withConnection
} from '../ai/connections'
import { resolveAgentAuth } from '../ai/auth-route'
import { remapOnProviderChange, resolveModel, taskModelChoices } from '../ai/models'
import { setApiKeyResolver, setAuthResolver } from '../agent/provider'
// === AI 연결 끝 =======================================================================
import { AuthService } from '../sync/auth'
import { hasSupabaseEnv } from '../sync/env'
import { createSessionStore } from '../sync/session-store'
import { createSupabaseBackend } from '../sync/supabase-backend'
import { SyncConnection } from '../sync/connect'
import { workspaceRemoteId } from '../sync/workspace-id'
import type { DeviceService } from '../sync/devices'
import { WorkspaceService } from '../workspace/service'
import { workspaceShortcutIndex } from '../workspace/shortcut'
import { ExtensionManager, createSessionExtensionHost } from '../extensions/manager'
import { createExtensionInstaller } from '../extensions/install-service'
import { extensionPopupUrl } from '../extensions/action'
import { ExtensionPopupHost, sessionWithExtension } from '../extensions/popup-view'
import { WEBSTORE_HOST, isExtensionId } from '../../shared/extensions'
import type { ExtensionActionResult, ExtensionAnchorDto } from '../../shared/extensions'
// === 폰 연동(3단계) — child_process 는 phone/process.ts 안에만 있다 ===================
import { createAdbRunner } from '../phone/process'
import { PhoneRepo } from '../phone/repo'
import { PhoneService } from '../phone/service'
import { registerPhoneScreenIpc } from '../phone/screen-ipc'
import { installPhoneTools, phoneToolsStatus } from '../phone/tools-install'
import { createPhoneOps } from '../agent/tools-phone'
import { readCodeFromImage, readKeypadLayout } from '../ai/visual'
import { OcrEngine } from '../ocr/engine'
import { createTabPagePort } from '../phone/tab-port'
import {
  AgentProgressRelay,
  createCodeReader,
  createKeypadReader,
  createPhoneAgentBridge,
  phoneProEnabled,
  PRO_OVERRIDE_ENV,
  SecretScreenGate
} from '../phone/wiring'
// === 화면 번역 · 이미지 번역 — 배선은 translate/register.ts 한 곳에 모여 있다 ==========
import { registerTranslate } from '../translate/register'
// === 사진·영상 캡처 — 배선은 capture/capture-ipc.ts 한 곳에 모여 있다 =================
import { registerCaptureIpc } from '../capture/capture-ipc'
import type { CaptureShortcutInput } from '../../shared/capture'

/**
 * 렌더러가 보낸 툴바 버튼 좌표를 숫자만 남긴 형태로 받는다.
 * 값이 빠지거나 숫자가 아니면 0 으로 본다 — 팝업은 그래도 창 왼쪽 위에 뜬다
 */
function toExtensionAnchor(raw: unknown): ExtensionAnchorDto {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    x: num(o.x),
    y: num(o.y),
    width: num(o.width),
    height: num(o.height),
    viewportWidth: num(o.viewportWidth),
    viewportHeight: num(o.viewportHeight)
  }
}

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
    // 마우스 제스처 설정은 페이지 preload 가 궤적을 그릴지 판단하는 데 필요하다
    tabs.setGestureConfig({
      enabled: s.mouseGesturesEnabled,
      language: s.language,
      mapping: s.mouseGestures
    })
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
  // AI 채팅 기록. 러너가 작업 완료 시점에 이 저장소로 대화를 남긴다
  const chats = new ChatRepo(db)
  agent.setTranscript((chatId, entry) => {
    chats.append({ chatId, role: 'user', content: entry.prompt })
    chats.append({ chatId, role: 'assistant', content: entry.text, steps: entry.steps })
  })
  // 자동화 플레이북. 사용자 문장에 트리거가 들어 있으면 러너가 절차를 시스템 프롬프트에 덧붙인다
  const playbooks = new PlaybookStore(settings)
  agent.setPlaybooks(() => playbooks.list())
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
    ipcMain.removeAllListeners(IPC.pageGesture)
    ipcMain.removeAllListeners(IPC.pageWebstoreInstall)
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
  handleFromRenderer(IPC.agentRun, (prompt: string, chatId?: number) => {
    void agent.run(prompt, chatId).catch((e: unknown) => console.error('작업 실행 실패', e))
    return { started: true }
  })

  // --- AI 채팅 기록 -------------------------------------------------------
  handleFromRenderer(IPC.chatList, (limit?: number) => chats.list(limit ?? RECENT_CHAT_LIMIT))
  handleFromRenderer(IPC.chatCreate, (title: string) => chats.create(title))
  handleFromRenderer(IPC.chatGet, (chatId: number) => chats.get(chatId))
  handleFromRenderer(IPC.chatAppend, (input: AppendMessageInput) => chats.append(input))
  handleFromRenderer(IPC.chatRename, (chatId: number, title: string) => chats.rename(chatId, title))
  handleFromRenderer(IPC.chatDelete, (chatId: number) => chats.remove(chatId))
  handleFromRenderer(IPC.agentStop, () => agent.stop())

  // --- 자동화 플레이북 — 절차 문서만 오간다(비밀값 없음) --------------------
  handleFromRenderer(IPC.playbookList, () => playbooks.list())
  handleFromRenderer(IPC.playbookPut, (input: PlaybookInput) => playbooks.put(input))
  handleFromRenderer(IPC.playbookDelete, (id: string) => playbooks.remove(id))
  handleFromRenderer(IPC.playbookRestore, (id: string) => playbooks.restore(id))
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
  handleFromRenderer(IPC.vaultKeyFromSync, () => vault.isKeyFromSync())
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
    excludedHosts: () => settings.get().vaultExcludedHosts,
    autoSubmit: () => settings.get().autofillAutoSubmit
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

  // === 마우스 제스처 ====================================================================
  // 닫은 탭 다시 열기용 스택(최대 10). 탭이 닫힐 때마다 주소를 쌓아 둔다
  const closedTabs = new ClosedTabStack()
  tabs.onTabClosed((closed) => closedTabs.push(closed))

  const gestureDeps: GestureDeps = {
    activeTabId: () => tabs.active()?.id ?? null,
    back: (id) => tabs.back(id),
    forward: (id) => tabs.forward(id),
    reload: (id) => tabs.reload(id),
    navigate: (id, url) => tabs.navigate(id, url),
    scrollTo: (id, to) => tabs.scrollTo(id, to),
    homeUrl: () => settings.get().homeUrl,
    newTab: () => {
      tabs.create({})
    },
    // 이 앱은 단일 창이라 '새 창 열기' 는 새 탭으로 대체한다(설정 라벨에도 그렇게 적혀 있다)
    newWindow: () => {
      tabs.create({})
    },
    // 시크릿창 대체 — 세션이 분리된 새 프로필 탭
    newProfileTab: () => {
      tabs.create({ profile: newProfileName(Date.now()) })
    },
    closeTab: (id) => tabs.close(id),
    reopenTab: () => {
      const last = closedTabs.pop()
      if (last) tabs.create({ url: last.url, profile: last.profile, mobile: last.mobile })
    },
    toggleFullScreen: () => {
      if (!win.isDestroyed()) win.setFullScreen(!win.isFullScreen())
    },
    maximize: () => {
      if (win.isDestroyed()) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    minimize: () => {
      if (!win.isDestroyed()) win.minimize()
    }
  }

  // 발신자는 반드시 관리 중인 탭이어야 한다(웹 페이지·확장의 위조 호출 차단)
  ipcMain.on(IPC.pageGesture, (e, raw: unknown) => {
    const tab = tabs.findByWebContents(e.sender)
    if (!tab) return
    // 방향 4글자(L/R/U/D)를 넘는 값은 인식기가 만들 수 없다 — 들어오면 버린다
    if (typeof raw !== 'string' || !/^[LRUD]{1,4}$/.test(raw)) return
    const s = settings.get()
    if (!s.mouseGesturesEnabled) return
    // 제스처가 일어난 그 탭을 대상으로 실행한다(활성 탭 추정에 기대지 않는다)
    void runGesture(raw, s.mouseGestures, {
      ...gestureDeps,
      activeTabId: () => tab.id
    }).catch((err: unknown) => {
      console.warn('마우스 제스처 실행 실패', err instanceof Error ? err.message : String(err))
    })
  })
  // === 마우스 제스처 끝 =================================================================

  // === AI 연결(2b 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) ======================
  // 평문 API 키는 이 저장소와 agent/provider.ts 안에만 머문다. 렌더러로 나가는 것은
  // 마스킹 문자열(sk-ant-••••1234)과 boolean 뿐이다
  const apiKeys = new ApiKeyStore(join(app.getPath('userData'), 'ai-keys.bin'), safeStorage)
  const aiProbes = defaultProbes()
  // ApiKeyStore.get 의 유일한 소비자(agent/provider.ts)에 조회기를 심는다.
  // 실제로 키를 꺼낼지는 provider.ts 가 인증 경로('api_key')를 보고 정한다
  setApiKeyResolver(() => apiKeys.get('anthropic'))
  // 이번 실행에 쓸 인증 경로. **연결한 적 없는 구독은 자격 파일이 있어도 쓰지 않는다**
  setAuthResolver(() => {
    const s = settings.get()
    return resolveAgentAuth({
      provider: s.aiProvider as AiProviderId,
      connections: s.aiConnections,
      // 평문 키는 여기까지 오지 않는다 — 마스킹 결과로 존재 여부만 본다
      hasApiKey: Boolean(apiKeys.masked().anthropic)
    })
  })
  win.once('closed', () => {
    setApiKeyResolver(null)
    setAuthResolver(null)
  })

  // 첫 실행 1회 승계: 이미 Claude 구독으로 쓰고 있던 기존 사용자는 연결됨으로 올려 준다
  {
    const s = settings.get()
    const patch = migrateAiConnections({
      migrated: s.aiConnectionsMigrated,
      aiProvider: s.aiProvider,
      connections: s.aiConnections,
      hasClaudeCredential: SUBSCRIPTION_CLI.claude_subscription.credentialPaths.some((p) =>
        aiProbes.fileExists(p)
      ),
      account: readAccountFromDisk('claude_subscription') ?? undefined
    })
    if (patch) {
      const inherited = patch.aiConnections.claude.connected && !s.aiConnections.claude.connected
      settings.set(patch)
      if (inherited) {
        console.info('[AI] 기존 Claude 구독 사용 상태를 연결됨으로 1회 승계했습니다')
      }
    }
  }

  handleFromRenderer(IPC.aiProviders, () =>
    detectProviders(aiProbes, apiKeys.masked(), settings.get().aiConnections)
  )
  // 연결: 자격이 있으면 연결 기록을 남기고, 없으면 이유만 돌려준다(화면이 안내를 띄운다)
  handleFromRenderer(IPC.aiConnect, async (raw: unknown, rawOpenTerminal: unknown) => {
    if (!isSubscriptionProviderId(raw)) throw new Error('알 수 없는 구독 경로')
    if (rawOpenTerminal === true) {
      // 새 터미널 창에서 로그인 명령을 띄운다(자격은 그 창에서 사용자가 직접 만든다)
      openLoginTerminal(raw)
      return { ok: false, reason: 'needs_login' }
    }
    const result = await connectSubscription(raw, aiProbes)
    if (result.ok && result.connection) {
      settings.set({
        aiConnections: withConnection(settings.get().aiConnections, raw, result.connection)
      })
    }
    return result
  })
  // 해지: 진행 중 작업이 없을 때만. 앱의 연결 기록만 지우고 CLI 로그인 파일은 두 손 대지 않는다
  handleFromRenderer(IPC.aiDisconnect, (raw: unknown) => {
    if (!isSubscriptionProviderId(raw)) throw new Error('알 수 없는 구독 경로')
    if (agent.isRunning()) throw new Error('작업이 끝난 뒤에 연결을 해지할 수 있어요')
    const next = withConnection(settings.get().aiConnections, raw, disconnectedRecord())
    settings.set({ aiConnections: next })
    return { ok: true, connection: next[connectionKeyOf(raw)] }
  })
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
    chats.setWorkspaceScope(scope)
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
  // 캡처 단축키(Alt+1~6)도 같은 창 안 입력 경로를 쓴다. 캡처 배선은 아래에서 붙는다
  let handleCaptureShortcut: (input: CaptureShortcutInput) => boolean = () => false
  const handleWindowShortcut = (input: CaptureShortcutInput): boolean =>
    handleWorkspaceShortcut(input) || handleCaptureShortcut(input)
  win.webContents.on('before-input-event', (e, input) => {
    if (handleWindowShortcut(input)) e.preventDefault()
  })
  tabs.setInputHandler(handleWindowShortcut)

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
    chats,
    // 주기마다 다시 불린다 — 작업공간을 바꿔도 다음 주기부터 새 uuid 로 올라간다.
    // 기본 작업공간만 기기 간 공유 대상이라 고정 uuid 를 쓴다(2b 범위)
    workspace: () => {
      const scope = workspace.scope()
      return { localId: scope.id, remoteId: workspaceRemoteId(db, scope.id, scope.isDefault) }
    },
    device: {
      hostname: () => os.hostname(),
      osLabel: () => `${os.type()} ${os.release()}`,
      appVersion: () => app.getVersion()
    }
  })
  // 수동 동기화는 연결을 거친다 — 최초 업로드가 놓친 행을 먼저 보충하고 한 주기를 돈다
  handleFromRenderer(IPC.syncNow, () => connection.syncNow())
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

  // 확장 액션 팝업(툴바 아이콘 아래에 붙는 작은 창). 창당 한 개만 떠 있는다
  const extensionPopup = new ExtensionPopupHost({
    win,
    onClosed: () => send(IPC.extPopupClosed, null)
  })
  win.once('closed', () => extensionPopup.dispose())
  // 팝업은 탭 뷰 위에 얹히는데, 탭을 전환하면 활성 탭 뷰가 다시 맨 위로 올라간다.
  // 크롬도 탭을 바꾸면 팝업을 닫으므로 여기서 함께 닫는다
  tabs.onActivated(() => extensionPopup.close())

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
  handleFromRenderer(IPC.extRemove, (id: string) => {
    extensionPopup.close()
    return extensions.remove(id)
  })
  handleFromRenderer(IPC.extSetEnabled, (id: string, enabled: boolean) => {
    if (extensionPopup.activeId() === id) extensionPopup.close()
    return extensions.setEnabled(id, enabled)
  })

  // 툴바 아이콘 클릭 → 크롬이 하던 일을 대신한다.
  // Electron 39 에는 chrome.action 이 없어 확장이 팝업을 띄워 달라고 할 수 없으므로,
  // manifest 의 default_popup 을 우리가 읽어 같은 자리에 같은 문서를 띄운다
  handleFromRenderer(IPC.extAction, (id: unknown, rawAnchor: unknown): ExtensionActionResult => {
    if (typeof id !== 'string') throw new Error('확장 id 가 올바르지 않아요')
    const item = extensions.find(id)
    if (!item) throw new Error('목록에 없는 확장이에요')
    if (!item.enabled) throw new Error('꺼져 있는 확장이에요')
    const anchor = toExtensionAnchor(rawAnchor)
    if (item.popup) {
      // 팝업은 그 확장이 로드된 세션에서 열어야 chrome.* 이 동작한다.
      // 보통은 지금 보고 있는 탭의 파티션 세션이고, 거기에 없으면 기본 세션으로 내려간다
      const active = tabs.active()?.view.webContents.session
      const ses = sessionWithExtension(id, [...(active ? [active] : []), session.defaultSession])
      if (!ses) throw new Error('확장이 올라간 세션을 찾지 못했어요')
      const open = extensionPopup.toggle({
        id,
        url: extensionPopupUrl(id, item.popup),
        session: ses,
        anchor
      })
      return { kind: 'popup', open }
    }
    extensionPopup.close()
    if (item.optionsPage) {
      // 팝업이 없으면 크롬은 chrome.action.onClicked 를 보낸다. Electron 은 그 이벤트를
      // 전달할 방법이 없어, 대신 설정 화면에 해당하는 옵션 페이지를 새 탭으로 연다
      tabs.create({ url: extensionPopupUrl(id, item.optionsPage), extension: true })
      return { kind: 'options', open: false }
    }
    return { kind: 'none', open: false }
  })
  handleFromRenderer(IPC.extPopupClose, () => extensionPopup.close())

  // 가져오기·웹스토어 설치. 결과 폴더는 항상 userData/extensions/<id> 이고, 로드는 위 관리자가 한다
  const extensionInstaller = createExtensionInstaller({
    manager: extensions,
    extensionsRoot: join(app.getPath('userData'), 'extensions'),
    localAppData: process.env.LOCALAPPDATA ?? '',
    chromiumVersion: process.versions.chrome ?? '120.0.0.0',
    fetchImpl: (url, init) => net.fetch(url, init)
  })
  handleFromRenderer(IPC.extImportSources, () => extensionInstaller.importSources())
  handleFromRenderer(IPC.extImportFrom, (ids: string[]) => extensionInstaller.importFrom(ids))
  handleFromRenderer(IPC.extInstallWebstore, (input: string) =>
    extensionInstaller.installWebstore(input)
  )

  // 웹스토어 탭에서 "Chrome에 추가" 를 누른 경우 — 크롬과 같은 설치 경험.
  // 발신자는 반드시 관리 중인 탭이면서 지금 보고 있는 주소가 웹스토어여야 한다
  // (웹 페이지·확장이 아무 id 나 밀어 넣어 설치시키는 것을 막는다)
  ipcMain.on(IPC.pageWebstoreInstall, (e, raw: unknown) => {
    if (!tabs.findByWebContents(e.sender)) return
    if (normalizeHost(e.sender.getURL()) !== WEBSTORE_HOST) return
    if (!isExtensionId(raw)) return
    const id = raw
    const sender = e.sender
    void extensionInstaller
      .installWebstore(id)
      .then((result) => {
        const ok = !result.error
        if (!ok) console.warn(`웹스토어 설치 실패(${id}): ${result.error}`)
        // 버튼 문구를 바꿔 주도록 누른 그 탭으로 결과를 돌려준다
        if (!sender.isDestroyed()) {
          sender.send(IPC.pageWebstoreInstallResult, { id, ok })
        }
        // 확장 페이지·퍼즐 메뉴가 열려 있으면 목록을 다시 읽게 한다
        if (ok) send(IPC.extChanged, null)
      })
      .catch((err: unknown) => {
        console.error('웹스토어 설치 처리 실패', err instanceof Error ? err.message : String(err))
        if (!sender.isDestroyed()) sender.send(IPC.pageWebstoreInstallResult, { id, ok: false })
      })
  })
  // === 확장 끝 =========================================================================

  // === 폰 연동(3단계) — 이 블록만 따로 추가한다 ========================================
  // 기기 감시는 Pro 요금제에서만 돈다. 결제 비밀번호·문자 본문은 이 채널들로 흐르지 않는다
  const phoneAdb = createAdbRunner(() => settings.get().adbPath)
  // 원클릭 설치본이 들어가는 자리(%APPDATA%/SAMBA Browser/phone-tools)
  const phoneToolsRoot = join(app.getPath('userData'), 'phone-tools')
  const phoneRepo = new PhoneRepo(db)
  // 요금제 게이트. 개발·검증용 우회는 배포판에서 통째로 무시된다
  const phoneIsPro = (): boolean =>
    phoneProEnabled({
      plan: auth.state().plan,
      devOverride: settings.get().phoneDevOverridePro,
      env: process.env[PRO_OVERRIDE_ENV],
      packaged: app.isPackaged
    })
  // 비밀번호 화면 표식(결제 실행기가 갱신 → 화면 전송이 참조)과 ARS 진행 로그 중계
  const phoneSecretGate = new SecretScreenGate()
  const phoneProgress = new AgentProgressRelay()
  const phones = new PhoneService({
    adb: phoneAdb,
    repo: phoneRepo,
    settings,
    toolsRoot: phoneToolsRoot,
    isPro: phoneIsPro,
    emit: (list, warning) => send(IPC.phoneUpdated, { list, warning }),
    emitAuthWaiting: (dto) => send(IPC.phoneAuthWaiting, dto),
    onProgress: (t) => phoneProgress.emit(t)
  })
  phones.start()
  win.once('closed', () => phones.dispose())

  handleFromRenderer(IPC.phoneList, () => phones.list())
  handleFromRenderer(IPC.phoneRefresh, () => phones.refresh())
  handleFromRenderer(IPC.phoneDetectPaths, () => phones.detectPaths())
  handleFromRenderer(IPC.phoneConnect, (address: string) => phones.connectWifi(address))
  handleFromRenderer(IPC.phoneDisconnect, (serial: string) => phones.disconnect(serial))
  handleFromRenderer(IPC.phoneRecover, (serial: string) => phones.recover(serial))
  handleFromRenderer(IPC.phoneSetLabel, (id: number, label: string, country: string) =>
    phones.setLabel(id, label, country)
  )
  handleFromRenderer(IPC.phoneAssign, (accountId: number, phoneId: number | null) =>
    phones.assign(accountId, phoneId)
  )
  handleFromRenderer(IPC.phoneAuthEvents, (limit?: number) => phones.authEvents(limit))
  // 폰 연동 프로그램 원클릭 설치 — 내려받기·해제·설정 저장까지 메인에서만 한다
  handleFromRenderer(IPC.phoneToolsStatus, () =>
    phoneToolsStatus({ root: phoneToolsRoot, settings })
  )
  handleFromRenderer(IPC.phoneInstallTools, () =>
    installPhoneTools({
      root: phoneToolsRoot,
      fetchImpl: (url, init) => net.fetch(url, init),
      settings,
      onProgress: (p) => send(IPC.phoneInstallProgress, p)
    })
  )
  // AI 폰 도구 배선. 금고는 넘기지 않는다 — 폰 도구는 비밀값을 볼 수 없다
  // AI 폰 도구 배선. 금고는 넘기지 않는다 — 폰 도구는 비밀값을 볼 수 없다.
  // 문자 인증·결제 승인만 별도 실행기(phone/wiring.ts)를 거치고, 결제 비밀번호는
  // 그 안의 pay-secret.ts 밖으로 나오지 않는다
  const phoneOps = createPhoneOps(phoneAdb, () => phones.list())
  const visualDeps = {
    apiKey: () => apiKeys.get('anthropic'),
    model: () => resolveModel(settings.get().taskModels, 'visual', settings.get().aiProvider)
  }
  const phoneOcr = new OcrEngine()
  const phoneBridge = createPhoneAgentBridge({
    adb: phoneAdb,
    phones: {
      list: () => phones.list(),
      assignForJob: (accountId) => phones.assignForJob(accountId),
      notifyAuthWaiting: (dto) => phones.notifyAuthWaiting(dto),
      watchArs: (siteHost) => phones.watchArs(siteHost)
    },
    ops: phoneOps,
    repo: phoneRepo,
    vault,
    page: createTabPagePort(tabs),
    settings: () => settings.get(),
    // 인증번호는 로컬 OCR 로 먼저 읽고, 못 읽었을 때만 Visual 을 부른다
    readCode: createCodeReader({
      ocrEnabled: () => settings.get().ocrEnabled,
      ocr: phoneOcr,
      visual: (png) => readCodeFromImage(visualDeps, png)
    }),
    readKeypad: createKeypadReader({
      adb: phoneAdb,
      screen: (serial) => phoneOps.screen(serial),
      readLayout: (png, size) => readKeypadLayout(visualDeps, png, size)
    }),
    secretGate: phoneSecretGate,
    progress: phoneProgress
  })
  agent.setPhones({
    phones: phoneOps,
    isPro: phoneIsPro,
    assigned: () => phones.list().find((p) => p.state === 'online')?.serial ?? null,
    waitForSmsCode: phoneBridge.waitForSmsCode,
    approvePayment: phoneBridge.approvePayment
  })
  // === 폰 연동 끝 ======================================================================

  // === 폰 화면(3단계 Task 5) ===========================================================
  // 화면 전송과 scrcpy 큰 창. 배선은 phone/screen-ipc.ts 한 곳에 모여 있다
  const phoneScreen = registerPhoneScreenIpc({
    handle: handleFromRenderer,
    send,
    settings: () => settings.get(),
    // 결제 비밀번호 화면 프레임은 보내지도 저장하지도 않는다
    isSecretScreen: (serial) => phoneSecretGate.isSecret(serial)
  })
  win.once('closed', () => phoneScreen.dispose())
  // === 폰 화면 끝 ======================================================================

  // === 화면 번역 · 이미지 번역 =========================================================
  const translate = registerTranslate({
    handle: handleFromRenderer,
    tabs,
    settings: () => settings.get(),
    apiKeys,
    userDataDir: app.getPath('userData'),
    // 진행률에는 개수와 고정된 사유 코드만 담긴다(원문·번역문은 오지 않는다)
    emit: (dto) => send(IPC.translateProgress, dto)
  })
  win.once('closed', () => translate.dispose())
  // === 번역 끝 ========================================================================
  // === 사진·영상 캡처 ==================================================================
  // 파일은 설정의 저장 폴더에만 쓰인다. 단축키는 위에서 만든 창 안 입력 경로에 붙는다
  const capture = registerCaptureIpc({
    handle: handleFromRenderer,
    send,
    settings: () => settings.get(),
    setSettings: (patch) => settings.set(patch),
    win,
    tabs,
    downloadsDir: () => app.getPath('downloads')
  })
  handleCaptureShortcut = capture.handleShortcut
  win.once('closed', () => capture.dispose())
  // === 캡처 끝 =========================================================================

  return { settings, agent, db, vault, auth, sync }
}
