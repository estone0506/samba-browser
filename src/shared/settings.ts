import { z } from 'zod'
import { AI_PROVIDERS, type AiProviderId, type TaskModels } from './ai'
import { DEFAULT_DANGER_WORDS, mergeDangerWords } from './danger'
import { EXTENSION_SOURCES, type ExtensionSource } from './extensions'
import { DEFAULT_PAYMENT_LIMIT_KRW, type ScreenFps, type ScreenSize } from './phone'
import { isHttpUrl, isInternalUrl, NEW_TAB_URL } from './url'

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
  taskModels: {
    fast: 'haiku',
    standard: 'sonnet',
    deep: 'opus',
    visual: 'sonnet'
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
  // 모양(기기 로컬 — 동기화하지 않는다)
  theme: 'system' as ThemeMode,
  uiZoom: 100,
  sidebarShowBookmarks: true,
  sidebarShowChat: true,
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
  paymentLimitKrw: DEFAULT_PAYMENT_LIMIT_KRW
  // === 폰 연동 끝 ===========================================================
}

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
  // 모양 — 범위를 벗어나거나 타입이 틀리면 기본값으로 되돌린다
  theme: z.enum(THEME_MODES).catch(DEFAULT_SETTINGS.theme),
  uiZoom: z.number().int().min(MIN_UI_ZOOM).max(MAX_UI_ZOOM).catch(DEFAULT_SETTINGS.uiZoom),
  sidebarShowBookmarks: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowBookmarks),
  sidebarShowChat: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowChat),
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
  paymentLimitKrw: z.number().int().min(0).catch(DEFAULT_SETTINGS.paymentLimitKrw)
  // === 폰 연동 끝 =============================================================
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
