// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SECTION_KEY,
  PLACEHOLDER_SECTION_KEYS,
  SECTIONS,
  SETTINGS_GROUPS,
  groupLabelKey,
  isPlaceholderSection,
  isSectionKey,
  normalizeRecoveryKey,
  resolveSectionKey,
  sectionsOfGroup
} from '@renderer/components/settings/sections'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

describe('설정 섹션 상수', () => {
  it('스펙 그대로의 순서를 지킨다', () => {
    expect(sectionsOfGroup('personal').map((s) => s.key)).toEqual([
      'general',
      'appearance',
      'account',
      'security',
      'keymaster'
    ])
    expect(sectionsOfGroup('agent').map((s) => s.key)).toEqual([
      'behavior',
      'ai',
      'automation',
      'phones',
      'notify'
    ])
  })

  it('다른 화면에 이미 있는 것은 설정에 두지 않는다', () => {
    // 확장(개발자)은 확장 프로그램 화면이 담당하고, 폰의 세부 설정은 폰 섹션 안의 패널이 담당한다.
    // 요금제 구분은 폐지돼 설정에 자리가 없다(키마스터·자동화는 2026-09-19, 폰은 2026-09-21 설정 안으로 들어왔다)
    for (const gone of ['phone', 'developer', 'plan']) {
      expect(isSectionKey(gone)).toBe(false)
    }
  })

  it('그룹 이름과 같은 이름의 섹션은 없다', () => {
    // "에이전트 > 에이전트" 처럼 같은 말이 겹치면 어디에 있는지 알 수 없다
    for (const s of SECTIONS) expect(SETTINGS_GROUPS).not.toContain(s.key)
  })

  it('섹션 키는 중복되지 않는다', () => {
    const keys = SECTIONS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('모든 섹션이 두 그룹 중 하나에 속한다', () => {
    for (const s of SECTIONS) expect(SETTINGS_GROUPS).toContain(s.group)
  })

  it('자리만 잡아 둔 섹션은 더 이상 없다(자동화는 별도 페이지)', () => {
    expect([...PLACEHOLDER_SECTION_KEYS]).toEqual([])
    expect(isPlaceholderSection('automation')).toBe(false)
    expect(isPlaceholderSection('general')).toBe(false)
  })
})

describe('섹션 라우팅', () => {
  it('유효한 키는 그대로 돌려준다', () => {
    for (const s of SECTIONS) expect(resolveSectionKey(s.key)).toBe(s.key)
  })

  it('알 수 없는 값은 기본 섹션으로 떨어진다', () => {
    expect(resolveSectionKey('없는섹션')).toBe(DEFAULT_SECTION_KEY)
    expect(resolveSectionKey(null)).toBe(DEFAULT_SECTION_KEY)
    expect(resolveSectionKey(123)).toBe(DEFAULT_SECTION_KEY)
    expect(resolveSectionKey(undefined)).toBe(DEFAULT_SECTION_KEY)
  })

  it('isSectionKey 는 문자열만 통과시킨다', () => {
    expect(isSectionKey('account')).toBe(true)
    expect(isSectionKey({ key: 'account' })).toBe(false)
  })

  it('기본 섹션은 목록에 존재한다', () => {
    expect(isSectionKey(DEFAULT_SECTION_KEY)).toBe(true)
  })
})

describe('복구 키 재입력 비교', () => {
  it('하이픈·공백·대소문자를 무시하고 비교한다', () => {
    const key = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ23'
    expect(normalizeRecoveryKey(key)).toBe('ABCDEFGHJKMNPQRSTVWXYZ23')
    expect(normalizeRecoveryKey(' abcd efgh jkmn pqrs tvwx yz23 ')).toBe(normalizeRecoveryKey(key))
  })

  it('다른 키는 다르게 정규화된다', () => {
    expect(normalizeRecoveryKey('ABCD-EFGH')).not.toBe(normalizeRecoveryKey('ABCD-EFGX'))
  })
})

// 중첩 객체를 'a.b.c' 형태의 평탄한 키 목록으로 편다
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

describe('i18n ko/en 키 집합', () => {
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('두 파일의 키 집합이 완전히 같다', () => {
    expect(koKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !koKeys.includes(k))).toEqual([])
  })

  it('섹션 라벨 키가 두 파일에 모두 있다', () => {
    for (const s of SECTIONS) {
      expect(koKeys).toContain(s.labelKey)
      expect(enKeys).toContain(s.labelKey)
    }
    for (const g of SETTINGS_GROUPS) {
      expect(koKeys).toContain(groupLabelKey(g))
      expect(enKeys).toContain(groupLabelKey(g))
    }
  })

  it('계정·동기화·AI·복구 키 묶음이 두 파일에 모두 있다', () => {
    for (const key of [
      'account.title',
      'account.devicesUnavailable',
      'account.deleteAccount',
      'sync.syncNow',
      'ai.taskTable.remapped',
      'recovery.confirmBody',
      'settingsPage.placeholder'
    ]) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })
})
