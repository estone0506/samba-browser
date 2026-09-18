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
 * 스펙 그대로의 순서.
 *   개인     일반 · 모양 · 계정 · 요금제(자리) · 보안
 *   에이전트 에이전트 · AI 연결 · 키마스터 · 자동화(자리) · 개발자(자리)
 */
export const SECTIONS: readonly SettingsSectionDef[] = [
  { group: 'personal', key: 'general', labelKey: 'settingsPage.sections.general' },
  { group: 'personal', key: 'appearance', labelKey: 'settingsPage.sections.appearance' },
  { group: 'personal', key: 'account', labelKey: 'settingsPage.sections.account' },
  { group: 'personal', key: 'plan', labelKey: 'settingsPage.sections.plan' },
  { group: 'personal', key: 'security', labelKey: 'settingsPage.sections.security' },
  { group: 'agent', key: 'agent', labelKey: 'settingsPage.sections.agent' },
  { group: 'agent', key: 'ai', labelKey: 'settingsPage.sections.ai' },
  { group: 'agent', key: 'keymaster', labelKey: 'settingsPage.sections.keymaster' },
  { group: 'agent', key: 'automation', labelKey: 'settingsPage.sections.automation' },
  { group: 'agent', key: 'developer', labelKey: 'settingsPage.sections.developer' }
]

/** 아직 화면이 없어 PlaceholderSection 으로 그리는 섹션 */
export const PLACEHOLDER_SECTION_KEYS: readonly string[] = ['plan', 'automation']

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
