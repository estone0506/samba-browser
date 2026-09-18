import { z } from 'zod'
import { DEFAULT_DANGER_WORDS, mergeDangerWords } from './danger'
import { isHttpUrl } from './url'

// 도구 호출 상한 허용 범위
export const MIN_TOOL_CALLS = 1
export const MAX_TOOL_CALLS = 200

// 오른쪽 패널 폭 허용 범위
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 900

// 자동 잠금 대기 시간(분) 허용 범위. 상한(43200 = 30일)은 "안 함"에 해당하는 매우 긴 시간이다
export const MIN_VAULT_AUTO_LOCK_MINUTES = 1
export const MAX_VAULT_AUTO_LOCK_MINUTES = 43200

// 키마스터 AI 에이전트 접근 정책: 항상 허용 · 잠금 해제 중에만 허용 · 절대 허용 안 함
export const VAULT_ACCESS_POLICIES = ['always', 'while_unlocked', 'never'] as const
export type VaultAccessPolicy = (typeof VAULT_ACCESS_POLICIES)[number]

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
  lastUrl: 'https://www.google.com',
  dangerWords: DEFAULT_DANGER_WORDS,
  maxToolCalls: 40,
  permissionMode: 'guard' as const,
  finalConfirm: false,
  // Aside 방식: 자동 잠금 기본 1주(10080분), 이 PC 에서 기억 기본 켬
  vaultAutoLockMinutes: 10080,
  vaultRememberDevice: true,
  vaultAccessPolicy: 'while_unlocked' as const,
  vaultAutoSubmit: true,
  vaultExcludedHosts: [] as string[],
  // === 홈/새 탭/검색엔진 기본값 (신규 추가분) ===============================
  homeUrl: 'https://www.google.com',
  newTabUrl: 'home' as const,
  searchEngine: 'google' as const
  // === 신규 추가분 끝 =======================================================
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
  // 제외 도메인(정규화된 host 문자열 목록). 손상된 값은 빈 배열로 되돌린다
  vaultExcludedHosts: z.array(z.string()).catch(DEFAULT_SETTINGS.vaultExcludedHosts),
  // === 홈/새 탭/검색엔진 (신규 추가분) =======================================
  // 홈 주소. http/https 가 아니면(about:blank·javascript: 등) 기본값으로 되돌린다
  homeUrl: z
    .string()
    .refine((v) => isHttpUrl(v))
    .catch(DEFAULT_SETTINGS.homeUrl),
  newTabUrl: z.enum(NEW_TAB_URL_MODES).catch(DEFAULT_SETTINGS.newTabUrl),
  searchEngine: z.enum(SEARCH_ENGINES).catch(DEFAULT_SETTINGS.searchEngine)
  // === 신규 추가분 끝 =========================================================
})

export type Settings = z.infer<typeof settingsSchema>

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
