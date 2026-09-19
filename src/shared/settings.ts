import { z } from 'zod'
import { AI_PROVIDERS, type AiConnections, type AiProviderId, type TaskModels } from './ai'
import { DEFAULT_DANGER_WORDS, mergeDangerWords } from './danger'
import { EXTENSION_SOURCES, type ExtensionSource } from './extensions'
import { defaultMouseGestures, GESTURE_ACTIONS } from './gestures'
import { DEFAULT_PAYMENT_LIMIT_KRW, type ScreenFps, type ScreenSize } from './phone'
import { DEFAULT_TRANSLATE_LANG, TRANSLATE_LANGS, type TranslateLang } from './translate'
import {
  CAPTURE_FORMATS,
  CAPTURE_MODES,
  DEFAULT_CAPTURE_SHORTCUTS,
  mergeCaptureShortcuts,
  type CaptureFormat,
  type CaptureShortcuts
} from './capture'
import { isHttpUrl, isInternalUrl, NEW_TAB_URL } from './url'
import { playbookListSchema, type PlaybookDto } from './playbook'

// 도구 호출 상한 허용 범위
export const MIN_TOOL_CALLS = 1
export const MAX_TOOL_CALLS = 200

// 오른쪽 패널 폭 허용 범위
// 패널 폭 한계(렌더러 uiStore 와 공유)
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 420
export const MIN_PANEL_WIDTH = 280
export const MAX_PANEL_WIDTH = 900

// 자동 잠금 대기 시간(분) 허용 범위. 상한(43200 = 30일)은 "안 함"에 해당하는 매우 긴 시간이다
export const MIN_VAULT_AUTO_LOCK_MINUTES = 1
export const MAX_VAULT_AUTO_LOCK_MINUTES = 43200

// 키마스터 AI 에이전트 접근 정책: 항상 허용 · 잠금 해제 중에만 허용 · 절대 허용 안 함
export const VAULT_ACCESS_POLICIES = ['always', 'while_unlocked', 'never'] as const
export type VaultAccessPolicy = (typeof VAULT_ACCESS_POLICIES)[number]

// 화면 테마: 시스템 따라감 · 밝게 · 어둡게
export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

// 화면 확대 비율(%) 허용 범위
export const MIN_UI_ZOOM = 80
export const MAX_UI_ZOOM = 150

// 사용 권한 모드: 읽기 전용(read_only) · 위험 행동 확인(guard) · 자동(full)
export const PERMISSION_MODES = ['read_only', 'guard', 'full'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

// 에이전트 추론 강도(Aside 하단 "Fable 5.1 High ▾" 와 같은 개념).
// Claude Agent SDK 의 effort 옵션 값과 같은 문자열을 쓴다
export const AGENT_EFFORTS = ['low', 'medium', 'high'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

// 사이드바 접힘 폭(아이콘만 보이는 폭)
export const SIDEBAR_COLLAPSED_WIDTH = 56

// 사이드바 안에서 따로 접을 수 있는 섹션들
export const SIDEBAR_SECTION_KEYS = ['tabs', 'chat', 'bookmarks'] as const
export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]
export type SidebarSections = Record<SidebarSectionKey, boolean>

// === 홈/새 탭/검색엔진 설정 (신규 추가분) ==================================
// 새 탭 주소: 'home' 이면 홈 주소를 따르고, 'blank' 면 빈 페이지로 연다
export const NEW_TAB_URL_MODES = ['home', 'blank'] as const
export type NewTabUrlMode = (typeof NEW_TAB_URL_MODES)[number]

// 기본 검색엔진 — 주소창에 검색어를 입력했을 때 사용
export const SEARCH_ENGINES = ['google', 'naver'] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]
// === 신규 추가분 끝 =========================================================

export const DEFAULT_SETTINGS = {
  model: 'sonnet' as const,
  language: 'ko' as const,
  panelWidth: 380,
  // 왼쪽 환경 탭(사이드바) 폭. 기기별 값이라 동기화하지 않는다
  sidebarWidth: 232,
  lastUrl: NEW_TAB_URL,
  dangerWords: DEFAULT_DANGER_WORDS,
  maxToolCalls: 40,
  permissionMode: 'guard' as const,
  finalConfirm: false,
  // Aside 방식: 자동 잠금 기본 1주(10080분), 이 PC 에서 기억 기본 켬
  vaultAutoLockMinutes: 10080,
  vaultRememberDevice: true,
  vaultAccessPolicy: 'while_unlocked' as const,
  vaultAutoSubmit: true,
  // 로그인 폼의 "로그인 상태 유지" 체크박스를 자동으로 켤지(세션 재사용 → 캡차 감소)
  vaultKeepSignedIn: true,
  // 저장된 값과 다른 값으로 로그인에 성공하면 묻지 않고 자동으로 비밀번호를 갱신할지 여부
  vaultAutoUpdatePassword: true,
  vaultExcludedHosts: [] as string[],
  // === 홈/새 탭/검색엔진 기본값 (신규 추가분) ===============================
  // 로컬 OCR(ocr 도구) 사용 여부. 첫 사용 시 모델(약 18MB)을 내려받는다
  ocrEnabled: true,
  // 기본 홈 주소는 자체 새 탭 페이지. 사용자가 config.json 에 저장해 둔 값이 있으면 그대로 유지된다
  homeUrl: NEW_TAB_URL,
  newTabUrl: 'home' as const,
  searchEngine: 'google' as const,
  // === 신규 추가분 끝 =======================================================
  // === AI 연결 / 에이전트 / 작업공간 (2b 추가분) ============================
  // AI 연결 경로와 작업별 모델
  aiProvider: 'claude_subscription' as AiProviderId,
  // 구독 연결 상태(기기 로컬 — 동기화하지 않는다).
  // 자격 파일이 있어도 connected 가 아니면 에이전트는 그 경로를 쓰지 않는다
  aiConnections: {
    claude: { connected: false },
    codex: { connected: false }
  } as AiConnections,
  // 기존 사용자 승계(구독으로 이미 쓰고 있던 상태 → connected)를 한 번만 하기 위한 표식
  aiConnectionsMigrated: false,
  taskModels: {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-5',
    deep: 'claude-opus-5',
    visual: 'claude-sonnet-5'
  } as TaskModels,
  // 에이전트 동작
  agentNotify: true,
  agentSound: false,
  // 에이전트가 연 탭을 몇 분 뒤 정리할지(0 이면 정리 안 함)
  agentTabCleanupMinutes: 15,
  // 작업공간(기기 로컬 — 동기화하지 않는다)
  activeWorkspaceId: 0,
  // 확장 폴더 경로(로컬 전용)
  extensionPaths: [] as string[],
  // 확장 경로별 출처(스토어/가져옴/폴더). 기록이 없으면 'folder' 로 본다
  extensionSources: {} as Record<string, ExtensionSource>,
  // 꺼 둔 확장의 id. 목록·경로는 그대로 두고 세션에만 올리지 않는다
  disabledExtensionIds: [] as string[],
  // 주소창 툴바에 고정한 확장의 id(왼쪽부터 이 순서대로 놓인다).
  // 툴바를 이 기기에서 어떻게 보여 줄지에 대한 값이라 동기화하지 않는다
  extensionsPinned: [] as string[],
  // 모양(기기 로컬 — 동기화하지 않는다)
  theme: 'system' as ThemeMode,
  uiZoom: 100,
  sidebarShowBookmarks: true,
  sidebarShowChat: true,
  // 사이드바 접기(아이콘 폭) 여부와 섹션별 펼침 상태 — 기기 로컬이라 동기화하지 않는다
  sidebarCollapsed: false,
  // 오른쪽 AI 패널 접힘(기기 로컬)
  panelCollapsed: false,
  sidebarSections: { tabs: true, chat: true, bookmarks: true } as SidebarSections,
  // 에이전트 추론 강도(채팅 입력줄에서 고른다). 기기 간 같은 값을 쓰도록 동기화한다
  agentEffort: 'medium' as AgentEffort,
  // === 2b 추가분 끝 =========================================================
  // === 폰 연동(3단계 추가분) ================================================
  // adb/scrcpy 실행 파일 경로. 빈 문자열이면 설정 화면의 "자동 찾기" 를 안내한다
  adbPath: '',
  scrcpyPath: '',
  // 폰 화면 품질(긴 변 픽셀 · 초당 프레임)
  phoneScreenMaxSize: 720 as ScreenSize,
  phoneScreenFps: 15 as ScreenFps,
  // 끊겼을 때 kill-server/start-server 로 1회 자동 복구할지
  phoneAutoReconnect: true,
  // 결제 상한(원). 초과하면 권한 모드와 무관하게 사람 확인을 받는다
  paymentLimitKrw: DEFAULT_PAYMENT_LIMIT_KRW,
  // 결제 비밀번호 키패드 배치를 외부 AI(Visual)에게 물어볼지.
  // 켜면 키패드 화면 원본이 AI 제공자로 전송되므로 기본은 꺼짐이고,
  // 꺼져 있으면 UI 트리로 못 읽은 키패드는 사람에게 넘긴다
  phoneKeypadVisual: false,
  // 개발·검증용 Pro 게이트 우회(기기 로컬·설정 UI 없음·동기화 안 함).
  // 환경변수 SAMBA_PHONE_PRO_OVERRIDE=1 로도 켜지고, 배포판에서는 통째로 무시된다
  phoneDevOverridePro: false,
  // === 폰 연동 끝 ===========================================================
  // === 마우스 제스처 ========================================================
  // 오른쪽 버튼 드래그 제스처 사용 여부와 시퀀스→동작 매핑(웨일 기본값 16종)
  mouseGesturesEnabled: true,
  mouseGestures: defaultMouseGestures(),
  // === 마우스 제스처 끝 =====================================================
  // === 번역(화면·이미지) ====================================================
  // 번역 결과의 기본 대상 언어
  translateTargetLang: DEFAULT_TRANSLATE_LANG as TranslateLang,
  // 열자마자 자동으로 번역할 도메인 목록(정규화된 host 문자열)
  translateAutoDomains: [] as string[],
  // === 번역 끝 ==============================================================
  // === 사진·영상 캡처(3단계 추가분) =========================================
  // 저장 폴더. 빈 문자열이면 메인이 `다운로드/SAMBA 캡처` 를 만들어 쓴다(기기별 값)
  captureDir: '',
  captureFormat: 'png' as CaptureFormat,
  // 영상 녹화에 마이크 소리를 함께 담을지
  captureMicrophone: false,
  // 이미지 저장 직후 클립보드에도 복사할지
  captureCopyToClipboard: false,
  // 캡처 단축키 표(설정에서 바꿀 수 있다)
  captureShortcuts: { ...DEFAULT_CAPTURE_SHORTCUTS } as CaptureShortcuts,
  // === 캡처 끝 ==============================================================
  // === 자동화 플레이북 ======================================================
  // 저장된 플레이북 전체(JSON 배열). 비어 있으면 저장소가 내장 플레이북을 채워 준다.
  // 표를 따로 만들지 않고 설정 한 칸에 담아 기존 설정 동기화 경로를 그대로 탄다
  playbooks: [] as PlaybookDto[]
  // === 자동화 플레이북 끝 ===================================================
}

// 구독 연결 기록 한 칸. account 는 화면 표시용 문자열뿐이고 토큰은 담지 않는다
const aiConnectionSchema = z
  .object({
    connected: z.boolean().catch(false),
    account: z.string().optional().catch(undefined),
    connectedAt: z.number().optional().catch(undefined)
  })
  .catch({ connected: false })

// 손상된 config.json 이어도 앱이 뜨도록 필드마다 catch 로 기본값으로 되돌린다
export const settingsSchema = z.object({
  model: z.enum(['sonnet', 'opus', 'haiku']).catch(DEFAULT_SETTINGS.model),
  language: z.enum(['ko', 'en']).catch(DEFAULT_SETTINGS.language),
  panelWidth: z
    .number()
    .min(MIN_PANEL_WIDTH)
    .max(MAX_PANEL_WIDTH)
    .catch(DEFAULT_SETTINGS.panelWidth),
  sidebarWidth: z
    .number()
    .min(MIN_SIDEBAR_WIDTH)
    .max(MAX_SIDEBAR_WIDTH)
    .catch(DEFAULT_SETTINGS.sidebarWidth),
  lastUrl: z.string().min(1).catch(DEFAULT_SETTINGS.lastUrl),
  dangerWords: z.array(z.string()).catch([]),
  maxToolCalls: z.number().catch(DEFAULT_SETTINGS.maxToolCalls),
  permissionMode: z.enum(PERMISSION_MODES).catch(DEFAULT_SETTINGS.permissionMode),
  finalConfirm: z.boolean().catch(DEFAULT_SETTINGS.finalConfirm),
  // 금고 미사용 자동 잠금(분). 손상된 값은 기본 1주(10080분)로 되돌린다
  vaultAutoLockMinutes: z
    .number()
    .int()
    .min(MIN_VAULT_AUTO_LOCK_MINUTES)
    .max(MAX_VAULT_AUTO_LOCK_MINUTES)
    .catch(DEFAULT_SETTINGS.vaultAutoLockMinutes),
  // 이 PC 에서 마스터 키를 safeStorage 로 감싸 기억할지 여부
  vaultRememberDevice: z.boolean().catch(DEFAULT_SETTINGS.vaultRememberDevice),
  // 키마스터 AI 에이전트 접근 정책
  vaultAccessPolicy: z.enum(VAULT_ACCESS_POLICIES).catch(DEFAULT_SETTINGS.vaultAccessPolicy),
  // 자동 채움 후 자동 제출 여부
  vaultAutoSubmit: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoSubmit),
  // 로그인 상태 유지 체크박스 자동 체크 여부
  vaultKeepSignedIn: z.boolean().catch(DEFAULT_SETTINGS.vaultKeepSignedIn),
  // 로그인 성공 감지 시 비밀번호 자동 갱신 여부(끄면 기존 "갱신할까요?" 프롬프트로 동작)
  vaultAutoUpdatePassword: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoUpdatePassword),
  // 제외 도메인(정규화된 host 문자열 목록). 손상된 값은 빈 배열로 되돌린다
  vaultExcludedHosts: z.array(z.string()).catch(DEFAULT_SETTINGS.vaultExcludedHosts),
  // === 홈/새 탭/검색엔진 (신규 추가분) =======================================
  // 홈 주소. http/https 나 내부 페이지(samba://newtab)가 아니면 기본값으로 되돌린다
  // 로컬 OCR 사용 여부
  ocrEnabled: z.boolean().catch(DEFAULT_SETTINGS.ocrEnabled),
  homeUrl: z
    .string()
    .refine((v) => isHttpUrl(v) || isInternalUrl(v))
    .catch(DEFAULT_SETTINGS.homeUrl),
  newTabUrl: z.enum(NEW_TAB_URL_MODES).catch(DEFAULT_SETTINGS.newTabUrl),
  searchEngine: z.enum(SEARCH_ENGINES).catch(DEFAULT_SETTINGS.searchEngine),
  // === 신규 추가분 끝 =========================================================
  // === AI 연결 / 에이전트 / 작업공간 (2b 추가분) ==============================
  aiProvider: z.enum(AI_PROVIDERS).catch(DEFAULT_SETTINGS.aiProvider),
  // 연결 기록이 깨졌으면 "미연결"로 되돌린다 — 의심스러우면 쓰지 않는 쪽이 안전하다
  aiConnections: z
    .object({
      claude: aiConnectionSchema,
      codex: aiConnectionSchema
    })
    .catch(DEFAULT_SETTINGS.aiConnections),
  aiConnectionsMigrated: z.boolean().catch(DEFAULT_SETTINGS.aiConnectionsMigrated),
  taskModels: z
    .object({
      fast: z.string(),
      standard: z.string(),
      deep: z.string(),
      visual: z.string()
    })
    .catch(DEFAULT_SETTINGS.taskModels),
  agentNotify: z.boolean().catch(DEFAULT_SETTINGS.agentNotify),
  agentSound: z.boolean().catch(DEFAULT_SETTINGS.agentSound),
  agentTabCleanupMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.agentTabCleanupMinutes),
  activeWorkspaceId: z.number().int().min(0).catch(DEFAULT_SETTINGS.activeWorkspaceId),
  extensionPaths: z.array(z.string()).catch(DEFAULT_SETTINGS.extensionPaths),
  extensionSources: z
    .record(z.string(), z.enum(EXTENSION_SOURCES))
    .catch(DEFAULT_SETTINGS.extensionSources),
  disabledExtensionIds: z.array(z.string()).catch(DEFAULT_SETTINGS.disabledExtensionIds),
  extensionsPinned: z.array(z.string()).catch(DEFAULT_SETTINGS.extensionsPinned),
  // 모양 — 범위를 벗어나거나 타입이 틀리면 기본값으로 되돌린다
  theme: z.enum(THEME_MODES).catch(DEFAULT_SETTINGS.theme),
  uiZoom: z.number().int().min(MIN_UI_ZOOM).max(MAX_UI_ZOOM).catch(DEFAULT_SETTINGS.uiZoom),
  sidebarShowBookmarks: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowBookmarks),
  sidebarShowChat: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowChat),
  sidebarCollapsed: z.boolean().catch(DEFAULT_SETTINGS.sidebarCollapsed),
  panelCollapsed: z.boolean().catch(DEFAULT_SETTINGS.panelCollapsed),
  // 섹션 중 하나만 망가져도 그 칸만 기본값(펼침)으로 되돌린다
  sidebarSections: z
    .object({
      tabs: z.boolean().catch(true),
      chat: z.boolean().catch(true),
      bookmarks: z.boolean().catch(true)
    })
    .catch(DEFAULT_SETTINGS.sidebarSections),
  agentEffort: z.enum(AGENT_EFFORTS).catch(DEFAULT_SETTINGS.agentEffort),
  // === 2b 추가분 끝 ===========================================================
  // === 폰 연동(3단계 추가분) — 경로는 기기별 값이라 동기화하지 않는다 ==========
  adbPath: z.string().catch(DEFAULT_SETTINGS.adbPath),
  scrcpyPath: z.string().catch(DEFAULT_SETTINGS.scrcpyPath),
  phoneScreenMaxSize: z
    .union([z.literal(720), z.literal(1080)])
    .catch(DEFAULT_SETTINGS.phoneScreenMaxSize),
  phoneScreenFps: z
    .union([z.literal(10), z.literal(15), z.literal(30)])
    .catch(DEFAULT_SETTINGS.phoneScreenFps),
  phoneAutoReconnect: z.boolean().catch(DEFAULT_SETTINGS.phoneAutoReconnect),
  paymentLimitKrw: z.number().int().min(0).catch(DEFAULT_SETTINGS.paymentLimitKrw),
  phoneKeypadVisual: z.boolean().catch(DEFAULT_SETTINGS.phoneKeypadVisual),
  phoneDevOverridePro: z.boolean().catch(DEFAULT_SETTINGS.phoneDevOverridePro),
  // === 폰 연동 끝 =============================================================
  // === 마우스 제스처 ==========================================================
  mouseGesturesEnabled: z.boolean().catch(DEFAULT_SETTINGS.mouseGesturesEnabled),
  // 알 수 없는 동작 이름이 섞이면 표 전체를 기본값으로 되돌린다(부분 손상 방지)
  mouseGestures: z.record(z.string(), z.enum(GESTURE_ACTIONS)).catch(() => defaultMouseGestures()),
  // === 마우스 제스처 끝 =======================================================
  // === 번역 — 손상된 값은 기본 언어·빈 목록으로 되돌린다 ======================
  translateTargetLang: z.enum(TRANSLATE_LANGS).catch(DEFAULT_SETTINGS.translateTargetLang),
  translateAutoDomains: z.array(z.string()).catch(DEFAULT_SETTINGS.translateAutoDomains),
  // === 번역 끝 ================================================================
  // === 사진·영상 캡처 — 기기별 값이라 동기화하지 않는다 ========================
  captureDir: z.string().catch(DEFAULT_SETTINGS.captureDir),
  captureFormat: z.enum(CAPTURE_FORMATS).catch(DEFAULT_SETTINGS.captureFormat),
  captureMicrophone: z.boolean().catch(DEFAULT_SETTINGS.captureMicrophone),
  captureCopyToClipboard: z.boolean().catch(DEFAULT_SETTINGS.captureCopyToClipboard),
  // 표기가 깨진 항목만 기본 단축키로 되돌린다(전체를 버리지 않는다)
  captureShortcuts: z
    .record(z.enum(CAPTURE_MODES), z.string())
    .catch({ ...DEFAULT_CAPTURE_SHORTCUTS })
    .transform((v): CaptureShortcuts => mergeCaptureShortcuts(v)),
  // === 캡처 끝 ================================================================
  // === 자동화 플레이북 — 한 칸이라도 깨지면 목록 전체를 비운다(저장소가 내장을 다시 채운다) ===
  playbooks: playbookListSchema.catch(() => [])
})

export type Settings = z.infer<typeof settingsSchema>

// 새 탭·첫 탭이 열 주소. 'blank' 면 빈 페이지, 아니면 홈 주소(기본값은 자체 새 탭 페이지)
export function defaultTabUrl(s: Pick<Settings, 'newTabUrl' | 'homeUrl'>): string {
  return s.newTabUrl === 'blank' ? 'about:blank' : s.homeUrl
}

export function clampToolCalls(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxToolCalls
  return Math.min(MAX_TOOL_CALLS, Math.max(MIN_TOOL_CALLS, Math.round(n)))
}

// 임의의 입력(파일 내용·IPC 패치 결과)을 항상 유효한 Settings 로 만든다
export function parseSettings(input: unknown): Settings {
  const r = settingsSchema.safeParse(input)
  const v = r.success ? r.data : { ...DEFAULT_SETTINGS }
  return {
    ...v,
    // 위험 단어는 기본 목록과의 합집합이라 사용자가 비워도 보호가 유지된다
    dangerWords: mergeDangerWords(v.dangerWords),
    maxToolCalls: clampToolCalls(v.maxToolCalls)
  }
}
