import type { PageSnapshot } from './snapshot'

// 렌더러 ↔ 메인 IPC 채널 이름. 문자열 하드코딩 금지
export const IPC = {
  tabList: 'tab:list',
  tabCreate: 'tab:create',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabNavigate: 'tab:navigate',
  tabBack: 'tab:back',
  tabForward: 'tab:forward',
  tabReload: 'tab:reload',
  tabSetMobile: 'tab:setMobile',
  tabUpdated: 'tab:updated', // main → renderer 이벤트
  layoutSet: 'layout:set',
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  agentEvent: 'agent:event', // main → renderer 이벤트
  agentConfirmReply: 'agent:confirmReply',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 금고 — vaultReveal 만이 비밀값(평문)을 돌려주는 유일한 채널이다
  vaultState: 'vault:state',
  vaultSetup: 'vault:setup',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultSites: 'vault:sites',
  vaultAccounts: 'vault:accounts',
  vaultItems: 'vault:items',
  vaultPutItem: 'vault:putItem',
  vaultDeleteItem: 'vault:deleteItem',
  vaultReveal: 'vault:reveal',
  vaultUpsertAccount: 'vault:upsertAccount',
  // 계정 삭제(딸린 항목까지)와 되돌리기. 되돌리기용 스냅샷은 메인 메모리에만 60초 머문다
  vaultDeleteAccounts: 'vault:deleteAccounts',
  vaultUndoDelete: 'vault:undoDelete',
  vaultAudit: 'vault:audit',
  // 내보내기 — 잠금 해제 + 마스터 재입력 검증을 통과해야만 실행된다(응답은 개수·경로뿐)
  vaultExport: 'vault:export',
  // 복구 키 — recoveryCreate 응답만 평문 복구 키를 돌려준다(화면 표시 1회용)
  vaultRecoveryCreate: 'vault:recoveryCreate',
  vaultRecoveryConfirm: 'vault:recoveryConfirm',
  vaultRecoveryUnlock: 'vault:recoveryUnlock',
  vaultStateChanged: 'vault:stateChanged', // main → renderer 이벤트
  vaultCapturePrompt: 'vault:capturePrompt', // main → renderer 이벤트 (비밀번호 제외)
  vaultCaptureDecision: 'vault:captureDecision', // renderer → main
  vaultCapture: 'vault:capture', // preload(격리 월드) → main, 폼 제출에서 감지한 자격정보
  vaultPasswordUpdated: 'vault:passwordUpdated', // main → renderer 이벤트, 로그인 성공 감지로 자동 갱신됨
  vaultUndoPasswordUpdate: 'vault:undoPasswordUpdate', // renderer → main, 자동 갱신 되돌리기
  // 상세 화면의 '자동 채우기' — 메인이 활성 탭에 직접 채운다(AI 미경유, 값은 IPC 로 나가지 않는다)
  vaultAutofill: 'vault:autofill',
  // 페이지 내 자동 채움 피커 — 목록은 {id,label,username} 만, 채우기는 메인이 수행한다
  vaultPickerAccounts: 'vault:pickerAccounts', // preload(격리 월드) → main (invoke)
  vaultPickerFill: 'vault:pickerFill', // preload(격리 월드) → main (send)
  // 가져오기 — filePath 생략 시 메인에서 dialog.showOpenDialog 를 연다
  importPasswords: 'import:passwords',
  importBookmarks: 'import:bookmarks',
  bookmarksTree: 'bookmarks:tree',
  bookmarksRemove: 'bookmarks:remove',
  // --- 북마크 관리자 페이지 (신규 추가분) -----------------------------------
  bookmarksCreateFolder: 'bookmarks:createFolder',
  bookmarksCreateLink: 'bookmarks:createLink',
  bookmarksRename: 'bookmarks:rename',
  bookmarksMove: 'bookmarks:move',
  bookmarksRemoveFolder: 'bookmarks:removeFolder',
  bookmarksSort: 'bookmarks:sort',
  bookmarksExport: 'bookmarks:export',
  // 파비콘 — 사이트 자체에서만 받아온 dataUrl 을 돌려준다(제3자 전송 없음)
  faviconGet: 'favicon:get',
  // --- 작업공간(브라우저 프로필) ---------------------------------------------
  workspaceList: 'workspace:list',
  workspaceCreate: 'workspace:create',
  workspaceSwitch: 'workspace:switch',
  workspaceRename: 'workspace:rename',
  workspaceDelete: 'workspace:delete',
  workspaceChanged: 'workspace:changed', // main → renderer 이벤트
  // --- 동기화(2b) — 상태 조회·즉시 동기화. 토큰·비밀값은 오가지 않는다 ---------
  syncStatus: 'sync:status',
  syncNow: 'sync:now',
  syncStatusChanged: 'sync:statusChanged', // main → renderer 이벤트
  // --- 기기(2b) — 목록과 원격 로그아웃. 토큰은 오가지 않는다 -------------------
  devicesList: 'devices:list',
  devicesRevoke: 'devices:revoke',
  // --- 자체 새 탭 페이지(samba://newtab) — preload(격리 월드) → 메인 -----------
  newTabInit: 'newtab:init', // invoke, 언어 + 북마크 바 상위 항목
  newTabSearch: 'newtab:search', // send, 검색어/URL 을 보낸 탭에서 연다
  newTabOpen: 'newtab:open', // send, 북마크 URL 을 보낸 탭에서 연다
  // --- AI 연결(2b) — 응답에 평문 API 키가 담기는 채널은 하나도 없다 -----------
  aiProviders: 'ai:providers', // 제공자 카드 3종 상태(마스킹 문자열만)
  aiSetProvider: 'ai:setProvider', // 제공자 전환 + 작업별 모델 자동 대체
  aiSetApiKey: 'ai:setApiKey', // 렌더러 → 메인 한 방향으로만 평문 키가 흐른다
  aiTestKey: 'ai:testKey', // 모델 목록 1회 호출로 확인, {ok} 만 반환
  aiTaskModels: 'ai:taskModels',
  aiSetTaskModel: 'ai:setTaskModel',
  // --- 계정 인증(2b) — 토큰·비밀번호는 어느 방향으로도 돌려주지 않는다 --------
  authState: 'auth:state',
  authSignUp: 'auth:signUp',
  authSignIn: 'auth:signIn',
  authSignInGoogle: 'auth:signInGoogle', // 브라우저를 열고 루프백 콜백까지 기다린다
  authSignOut: 'auth:signOut',
  authStateChanged: 'auth:stateChanged', // main → renderer 이벤트
  // --- 확장(2b) — 폴더 불러오기 + 다른 브라우저 가져오기 + 웹스토어 설치 ------
  extList: 'ext:list',
  extLoad: 'ext:load', // 경로를 안 주면 메인에서 폴더 선택 다이얼로그를 연다
  extRemove: 'ext:remove',
  extImportSources: 'ext:importSources', // 다른 브라우저에 설치된 확장 목록
  extImportFrom: 'ext:importFrom', // 고른 확장을 앱 데이터로 복사해서 로드
  extInstallWebstore: 'ext:installWebstore' // 웹스토어 주소 또는 32자 id
} as const

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// agent:run 의 즉시 응답. 작업 완료 여부가 아니라 "시작을 받았다"는 뜻만 담는다
export interface AgentRunAck {
  started: boolean
}

export interface TabInfo {
  id: string
  url: string
  title: string
  profile: string
  mobile: boolean
  loading: boolean
  active: boolean
}

// 렌더러가 메인에 알려주는 웹뷰 영역(사이드바·패널 제외)
export interface Layout {
  x: number
  y: number
  width: number
  height: number
  // 이 좌표를 잰 시점의 렌더러 뷰포트 크기(innerWidth/innerHeight).
  // 메인은 여기서 오른쪽·아래 여백을 뽑아 "현재" 창 크기에 다시 투영한다.
  // 창 크기 변경 중 렌더러 보고가 늦거나 누락돼도 웹뷰가 카드 밖으로 삐져나오지 않게 하는 기준값
  viewportWidth: number
  viewportHeight: number
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; label: string; ok: boolean }
  | { type: 'confirm'; requestId: string; action: string; kind?: 'danger' | 'finish' }
  // 진행 상황만 알리는 이벤트(도구 호출 아님). 지금은 SDK 재시도 대기 표시에 쓴다
  | { type: 'progress'; kind: 'apiRetry'; attempt: number; reason: string }
  | {
      type: 'status'
      state: 'running' | 'done' | 'failed' | 'stopped'
      message?: string
      toolCalls?: number
    }

// Settings 는 shared/settings.ts 의 zod 스키마에서 파생된 타입 (z.infer)
export type { Settings } from './settings'

export type { PageSnapshot }

export type {
  VaultItemType,
  VaultField,
  VaultSection,
  FieldKind,
  AgentAccess,
  SiteDto,
  AccountDto,
  PickerAccountDto,
  VaultItemMeta,
  VaultState,
  CapturePromptDto,
  PasswordUpdatedDto,
  AuditLogDto
} from './vault'

export type {
  AiProviderId,
  AiProviderState,
  AiProviderStatus,
  ApiKeyVendor,
  TaskModelKey,
  TaskModels
} from './ai'

export type {
  ExtensionDto,
  ExtensionError,
  ExtensionInstallResult,
  ExtensionListDto,
  ExtensionSource,
  ImportBrowserDto,
  ImportExtensionDto
} from './extensions'

export type {
  ImportPasswordsResult,
  ImportBookmarksResult,
  BookmarkTreeDto,
  BookmarkFolderDto,
  BookmarkLinkDto
} from './import'

export type { SyncStatus, DeviceDto } from './sync'
