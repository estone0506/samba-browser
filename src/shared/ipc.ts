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
  // --- AI 채팅 기록 — 본문은 평문이지만 비밀값은 담기지 않는다(진행 로그는 라벨만) ----
  chatList: 'chat:list',
  chatCreate: 'chat:create',
  chatGet: 'chat:get',
  chatAppend: 'chat:append',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 금고 — vaultReveal 만이 비밀값(평문)을 돌려주는 유일한 채널이다
  vaultState: 'vault:state',
  vaultKeyFromSync: 'vault:keyFromSync', // 키 재료가 다른 PC 에서 내려왔는가(안내 문구용)
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
  // 마우스 제스처 — 페이지 preload 가 인식한 방향 시퀀스와, 메인이 밀어 주는 설정
  pageGesture: 'page:gesture', // preload(격리 월드) → main (send)
  pageGestureConfig: 'page:gestureConfig', // main → preload 이벤트
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
  aiProviders: 'ai:providers', // 제공자 카드 4종 상태(마스킹 문자열만)
  aiConnect: 'ai:connect', // 구독 연결(자격이 없으면 이유만 돌려준다)
  aiDisconnect: 'ai:disconnect', // 구독 연결 해지(PC 의 CLI 로그인 파일은 건드리지 않는다)
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
  extSetEnabled: 'ext:setEnabled', // 목록에는 남기고 세션에서만 올리거나 걷어낸다
  extImportSources: 'ext:importSources', // 다른 브라우저에 설치된 확장 목록
  extImportFrom: 'ext:importFrom', // 고른 확장을 앱 데이터로 복사해서 로드
  extInstallWebstore: 'ext:installWebstore', // 웹스토어 주소 또는 32자 id
  extChanged: 'ext:changed', // main → renderer 이벤트(목록이 바뀌었으니 다시 읽어라)
  // 툴바 아이콘·퍼즐 메뉴 항목 클릭 → 팝업 문서를 띄우거나 옵션 페이지를 새 탭으로 연다.
  // Electron 에 chrome.action 이 없어 크롬이 하던 이 일을 앱이 직접 한다
  extAction: 'ext:action',
  extPopupClose: 'ext:popupClose', // 렌더러가 팝업을 닫는다(탭 전환 등)
  extPopupClosed: 'ext:popupClosed', // main → renderer 이벤트(버튼 눌림 표시를 되돌려라)
  // 웹스토어 탭에서 "Chrome에 추가" 를 누른 경우 — 크롬과 같은 설치 경험
  pageWebstoreInstall: 'page:webstoreInstall', // preload(격리 월드) → main (send)
  pageWebstoreInstallResult: 'page:webstoreInstallResult', // main → preload 이벤트
  // --- 폰 연동(3단계) — 값(결제 비밀번호·문자 본문)은 어느 채널에도 흐르지 않는다 ---
  phoneList: 'phone:list',
  phoneRefresh: 'phone:refresh', // 즉시 스캔
  phoneDetectPaths: 'phone:detectPaths', // adb/scrcpy 경로 자동 찾기
  phoneConnect: 'phone:connect', // 와이파이 주소로 연결
  phoneDisconnect: 'phone:disconnect',
  phoneRecover: 'phone:recover', // kill/start-server 1회 재시도
  phoneSetLabel: 'phone:setLabel', // 별칭·국가
  phoneAssign: 'phone:assign', // 계정 ↔ 폰 매핑
  phoneScreenStart: 'phone:screenStart',
  phoneScreenStop: 'phone:screenStop',
  phoneScreenChunk: 'phone:screenChunk', // main → renderer 이벤트(영상 청크/스틸 이미지)
  phoneScreenMode: 'phone:screenMode', // main → renderer 이벤트(video ↔ still 전환)
  phoneOpenWindow: 'phone:openWindow', // scrcpy 별도 창으로 크게 보기
  phoneTap: 'phone:tap', // 사용자가 화면을 직접 눌렀을 때
  phoneSwipe: 'phone:swipe',
  phoneKey: 'phone:key',
  phoneUpdated: 'phone:updated', // main → renderer 이벤트(목록·상태)
  phoneAuthWaiting: 'phone:authWaiting', // main → renderer 이벤트(카드 자동 펼침)
  phoneAuthEvents: 'phone:authEvents', // KPI 목록
  phoneToolsStatus: 'phone:toolsStatus', // adb·scrcpy 설치 상태(경로·버전)
  phoneInstallTools: 'phone:installTools', // 원클릭 설치(내려받기 → 해제 → 설정 저장)
  phoneInstallProgress: 'phone:installProgress', // main → renderer 이벤트(설치 진행률)
  // --- 번역(화면·이미지) — 원문/번역문만 오간다. 입력값·비밀번호는 실리지 않는다 ---
  pageTranslate: 'page:translate', // preload(격리 월드) → 메인, 탭 전용 게이트
  pageTranslateProgress: 'page:translateProgress', // preload → 메인, 진행률(개수·사유 코드만)
  translateProgress: 'translate:progress', // main → renderer 이벤트(번역 중 12/398 · 실패 사유)
  translateRun: 'translate:run', // 렌더러 → 메인, 활성 탭 화면 번역 시작
  translateRestore: 'translate:restore', // 렌더러 → 메인, 원문 보기
  translateCacheClear: 'translate:cacheClear', // 렌더러 → 메인, 번역 캐시 비우기
  // --- 사진·영상 캡처 — 파일은 사용자가 고른 폴더에만 저장된다 ----------------
  captureStill: 'capture:still', // 직접 지정용 정지 이미지(웹뷰 1장)
  captureRun: 'capture:run', // 방식별 캡처 실행(영역/전체 페이지/전체 화면)
  captureSaveImage: 'capture:saveImage', // 렌더러가 잘라낸 이미지를 저장
  captureVideoSource: 'capture:videoSource', // 녹화용 desktopCapturer 소스 + 크롭
  captureSaveVideo: 'capture:saveVideo', // 녹화 결과(webm) 저장(한 번에)
  // 녹화 중 청크를 바로 파일에 이어 쓴다 — 앱이 죽어도 직전까지 남는다
  captureBeginVideo: 'capture:beginVideo', // 파일 열기 → { token, 파일 이름 }
  captureAppendVideo: 'capture:appendVideo', // 청크 덧붙이기(토큰 필요)
  captureEndVideo: 'capture:endVideo', // 마무리(완료 이벤트, 토큰 필요)
  captureCancelVideo: 'capture:cancelVideo', // 시작 실패·중단 — 파일을 닫고 지운다
  captureCopyImage: 'capture:copyImage', // 저장된 이미지를 클립보드로
  captureOpenFile: 'capture:openFile',
  captureOpenFolder: 'capture:openFolder', // 인자가 없으면 저장 폴더 자체를 연다
  captureDir: 'capture:dir', // 지금 쓰는 저장 폴더 경로(메뉴에 보여 준다)
  capturePickDir: 'capture:pickDir', // 저장 폴더 선택 다이얼로그
  captureShortcut: 'capture:shortcut', // main → renderer 이벤트(Alt+1~6)
  captureDone: 'capture:done', // main → renderer 이벤트(캡처 완료 → 토스트)
  captureRegionMode: 'capture:regionMode', // main → page preload(격리 월드) 요소 선택 모드
  captureElementRect: 'capture:elementRect', // page preload(격리 월드) → main, 전용 게이트
  // --- 자동화 플레이북 — 절차 문서뿐이라 비밀값은 오가지 않는다 ---------------
  playbookList: 'playbook:list',
  playbookPut: 'playbook:put', // 새로 만들기 + 수정(id 없으면 새로 만든다)
  playbookDelete: 'playbook:delete',
  playbookRestore: 'playbook:restore' // 내장 플레이북 기본값 복원
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
  // 진행 상황만 알리는 이벤트(도구 호출 아님). SDK 재시도 대기와, 플레이북이 부르는
  // progress 도구의 "3/26" 표시 두 가지가 이 자리에 온다
  | { type: 'progress'; kind: 'apiRetry'; attempt: number; reason: string }
  | { type: 'progress'; kind: 'task'; done: number; total: number; label?: string }
  // 이번 실행에 적용된 플레이북 이름들(채팅 상단 배지). 절차 본문은 보내지 않는다
  | { type: 'playbook'; names: string[] }
  // 캡차·2FA 를 사용자에게 넘김. 응답은 agentConfirmReply 채널을 그대로 쓴다
  // (approved=true → 건너뛰고 계속, false → 작업 중단)
  | { type: 'handoff'; requestId: string; kind: 'captcha'; matched: string; url: string }
  // 넘김 종료(사용자 처리 감지로 자동 재개 포함). 카드를 닫고 진행 로그를 남긴다
  | {
      type: 'handoffDone'
      requestId: string
      outcome: 'resumed' | 'skipped' | 'aborted' | 'timeout'
    }
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
  PaymentProvider,
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
  AiConnectResult,
  AiConnection,
  AiConnections,
  AiProviderState,
  AiProviderStatus,
  ApiKeyVendor,
  SubscriptionProviderId,
  TaskModelKey,
  TaskModels
} from './ai'

export type {
  ExtensionActionKind,
  ExtensionActionResult,
  ExtensionAnchorDto,
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

export type {
  TranslateLang,
  TranslateRequest,
  ImageTextBox,
  ImageTranslateDto,
  TranslateProgressDto,
  TranslateProgressKind,
  TranslateFailReason
} from './translate'

export type {
  PhoneDto,
  PhoneUpdatedDto,
  AuthEventDto,
  PhoneAuthWaitingDto,
  PhoneCountry,
  PhoneState,
  PhoneTransport,
  ScreenMode,
  PhoneScreenChunkDto,
  PhoneScreenModeDto,
  PhoneToolsStatusDto,
  PhoneToolsProgressDto
} from './phone'

export type {
  CaptureMode,
  CaptureFormat,
  CaptureRect,
  CaptureShortcuts,
  CaptureResultDto,
  CaptureBeginVideoDto,
  CaptureStillDto,
  CaptureVideoSourceDto
} from './capture'

export type { PlaybookDto, PlaybookInput } from './playbook'

export type {
  ChatRole,
  ChatStepDto,
  ChatDto,
  ChatMessageDto,
  ChatDetailDto,
  AppendMessageInput
} from './chat'
