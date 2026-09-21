// 설정 화면의 섹션 목록과 라우팅 순수 로직.
// React 를 import 하지 않는 순수 모듈이라 그대로 테스트할 수 있다

export const SETTINGS_GROUPS = ['personal', 'agent'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

export interface SettingsSectionDef {
  group: SettingsGroup
  key: string
  labelKey: string
}

/**
 * 설정에는 "다른 화면에 이미 있는 것"을 두지 않는다.
 *   개인     일반 · 모양 · 계정 · 보안 · 키마스터
 *   AI       동작 · AI 연결 · 자동화 · 폰 · 알림 연동
 * (키마스터·자동화는 2026-09-19, 폰은 2026-09-21 사이드바에서 설정 안으로 옮겼다 — 사이드바를 얇게)
 *
 * 여기서 빠진 것들이 간 곳.
 * - 키마스터 정책 → 보안 섹션
 * - 폰(경로·화면 품질·결제 상한) → 폰 섹션 안의 "폰 설정" 패널
 * - 개발자(확장 관리) → 확장 프로그램 전용 페이지
 *
 * 그룹 이름과 섹션 이름이 똑같으면(에이전트 > 에이전트) 어디에 있는지 알 수 없어
 * 에이전트 그룹의 첫 섹션은 "동작"으로 부른다
 */
export const SECTIONS: readonly SettingsSectionDef[] = [
  { group: 'personal', key: 'general', labelKey: 'settingsPage.sections.general' },
  { group: 'personal', key: 'appearance', labelKey: 'settingsPage.sections.appearance' },
  { group: 'personal', key: 'account', labelKey: 'settingsPage.sections.account' },
  { group: 'personal', key: 'security', labelKey: 'settingsPage.sections.security' },
  { group: 'personal', key: 'keymaster', labelKey: 'settingsPage.sections.keymaster' },
  { group: 'agent', key: 'behavior', labelKey: 'settingsPage.sections.behavior' },
  { group: 'agent', key: 'ai', labelKey: 'settingsPage.sections.ai' },
  { group: 'agent', key: 'automation', labelKey: 'settingsPage.sections.automation' },
  { group: 'agent', key: 'phones', labelKey: 'settingsPage.sections.phones' },
  { group: 'agent', key: 'notify', labelKey: 'settingsPage.sections.notify' }
]

/** 자체 레이아웃(두 칸·자체 스크롤)을 가진 섹션 — 설정의 560px 폭 틀 없이 그린다 */
export const FULL_WIDTH_SECTION_KEYS: readonly string[] = ['keymaster', 'automation', 'phones']

export function isFullWidthSection(key: string): boolean {
  return FULL_WIDTH_SECTION_KEYS.includes(key)
}

/** 아직 화면이 없어 PlaceholderSection 으로 그리는 섹션(지금은 없다) */
export const PLACEHOLDER_SECTION_KEYS: readonly string[] = []

/** 처음 열릴 때 보여 줄 섹션 */
export const DEFAULT_SECTION_KEY = 'general'

export function isSectionKey(v: unknown): boolean {
  return typeof v === 'string' && SECTIONS.some((s) => s.key === v)
}

/** 알 수 없는 값이 들어와도 항상 유효한 섹션 키를 돌려준다 */
export function resolveSectionKey(v: unknown): string {
  return isSectionKey(v) ? (v as string) : DEFAULT_SECTION_KEY
}

export function sectionsOfGroup(group: SettingsGroup): SettingsSectionDef[] {
  return SECTIONS.filter((s) => s.group === group)
}

export function isPlaceholderSection(key: string): boolean {
  return PLACEHOLDER_SECTION_KEYS.includes(key)
}

/** 그룹 제목의 i18n 키 */
export function groupLabelKey(group: SettingsGroup): string {
  return `settingsPage.groups.${group}`
}

/**
 * 복구 키 비교용 정규화.
 * 사용자가 그룹 구분자를 빼거나 소문자로 붙여 넣어도 같은 키로 보도록
 * 공백·하이픈을 지우고 대문자로 맞춘다
 */
export function normalizeRecoveryKey(v: string): string {
  return v.replace(/[\s-]/g, '').toUpperCase()
}
