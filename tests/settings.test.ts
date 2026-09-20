import { describe, it, expect } from 'vitest'
import {
  parseSettings,
  clampToolCalls,
  DEFAULT_SETTINGS,
  MIN_TOOL_CALLS,
  MAX_TOOL_CALLS
} from '../src/shared/settings'
import { DEFAULT_DANGER_WORDS } from '@shared/danger'

describe('parseSettings — 손상된 config', () => {
  it('빈 객체는 전부 기본값', () => {
    const s = parseSettings({})
    expect(s.model).toBe(DEFAULT_SETTINGS.model)
    expect(s.language).toBe(DEFAULT_SETTINGS.language)
    expect(s.panelWidth).toBe(DEFAULT_SETTINGS.panelWidth)
    expect(s.maxToolCalls).toBe(DEFAULT_SETTINGS.maxToolCalls)
  })
  it('객체가 아니어도 기본값으로 복구', () => {
    expect(parseSettings(null).model).toBe(DEFAULT_SETTINGS.model)
    expect(parseSettings('망가짐').maxToolCalls).toBe(DEFAULT_SETTINGS.maxToolCalls)
    expect(parseSettings([1, 2, 3]).language).toBe(DEFAULT_SETTINGS.language)
  })
  it('타입이 틀린 필드만 기본값으로 되돌린다', () => {
    const s = parseSettings({ model: 'gpt', language: 'en', panelWidth: '넓게' })
    expect(s.model).toBe('sonnet')
    expect(s.language).toBe('en')
    expect(s.panelWidth).toBe(DEFAULT_SETTINGS.panelWidth)
  })
  it('패널 폭 범위를 벗어나면 기본값', () => {
    expect(parseSettings({ panelWidth: 10 }).panelWidth).toBe(DEFAULT_SETTINGS.panelWidth)
    expect(parseSettings({ panelWidth: 99999 }).panelWidth).toBe(DEFAULT_SETTINGS.panelWidth)
  })
})

describe('parseSettings — dangerWords 합집합', () => {
  it('빈 배열이어도 기본 위험 단어가 남는다', () => {
    const s = parseSettings({ dangerWords: [] })
    expect(s.dangerWords).toEqual(DEFAULT_DANGER_WORDS)
  })
  it('사용자 단어는 기본 목록 뒤에 더해진다', () => {
    const s = parseSettings({ dangerWords: ['환불'] })
    expect(s.dangerWords).toContain('환불')
    for (const w of DEFAULT_DANGER_WORDS) expect(s.dangerWords).toContain(w)
  })
  it('대소문자만 다른 중복은 제거된다', () => {
    const s = parseSettings({ dangerWords: ['PAY', 'pay', '결제'] })
    expect(s.dangerWords.filter((w) => w.toLowerCase() === 'pay')).toHaveLength(1)
  })
  it('문자열 배열이 아니면 기본 목록만 남는다', () => {
    expect(parseSettings({ dangerWords: '결제' }).dangerWords).toEqual(DEFAULT_DANGER_WORDS)
  })
})

describe('maxToolCalls 기본값', () => {
  // 주문 흐름(로그인→검색→옵션→장바구니→주문서)이 40회에서 끊겼던 회귀
  it('기본 120회, 상한 200회', () => {
    expect(DEFAULT_SETTINGS.maxToolCalls).toBe(120)
    expect(MAX_TOOL_CALLS).toBe(200)
  })
  it('빈 설정도 120회로 시작한다', () => {
    expect(parseSettings({}).maxToolCalls).toBe(120)
  })
})

describe('parseSettings — maxToolCalls clamp', () => {
  it('과대값은 상한으로', () => {
    expect(parseSettings({ maxToolCalls: 100000 }).maxToolCalls).toBe(MAX_TOOL_CALLS)
  })
  it('0·음수는 하한으로', () => {
    expect(parseSettings({ maxToolCalls: 0 }).maxToolCalls).toBe(MIN_TOOL_CALLS)
    expect(parseSettings({ maxToolCalls: -5 }).maxToolCalls).toBe(MIN_TOOL_CALLS)
  })
  it('소수는 반올림', () => {
    expect(parseSettings({ maxToolCalls: 10.6 }).maxToolCalls).toBe(11)
  })
  it('숫자가 아니면 기본값', () => {
    expect(parseSettings({ maxToolCalls: '많이' }).maxToolCalls).toBe(DEFAULT_SETTINGS.maxToolCalls)
    expect(clampToolCalls(Number.NaN)).toBe(DEFAULT_SETTINGS.maxToolCalls)
  })
})

describe('parseSettings — permissionMode / finalConfirm', () => {
  it('기본값은 guard 모드, finalConfirm 은 꺼짐', () => {
    const s = parseSettings({})
    expect(s.permissionMode).toBe('guard')
    expect(s.finalConfirm).toBe(false)
  })
  it('유효한 값은 그대로 반영된다', () => {
    expect(parseSettings({ permissionMode: 'read_only' }).permissionMode).toBe('read_only')
    expect(parseSettings({ permissionMode: 'full' }).permissionMode).toBe('full')
    expect(parseSettings({ finalConfirm: true }).finalConfirm).toBe(true)
  })
  it('잘못된 값은 기본값으로 되돌린다', () => {
    expect(parseSettings({ permissionMode: 'admin' }).permissionMode).toBe('guard')
    expect(parseSettings({ permissionMode: 123 }).permissionMode).toBe('guard')
    expect(parseSettings({ finalConfirm: 'yes' }).finalConfirm).toBe(false)
  })
})

describe('parseSettings — vaultAutoLockMinutes / vaultRememberDevice', () => {
  it('기본값은 1주(10080분), 기기 기억은 켜짐(Aside 방식)', () => {
    const s = parseSettings({})
    expect(s.vaultAutoLockMinutes).toBe(10080)
    expect(s.vaultRememberDevice).toBe(true)
  })
  it('유효한 값은 그대로 반영된다', () => {
    expect(parseSettings({ vaultAutoLockMinutes: 30 }).vaultAutoLockMinutes).toBe(30)
    expect(parseSettings({ vaultRememberDevice: false }).vaultRememberDevice).toBe(false)
  })
  it('범위를 벗어난 자동 잠금 시간은 기본값(1주)으로 되돌아간다', () => {
    expect(parseSettings({ vaultAutoLockMinutes: 0 }).vaultAutoLockMinutes).toBe(
      DEFAULT_SETTINGS.vaultAutoLockMinutes
    )
    expect(parseSettings({ vaultAutoLockMinutes: -5 }).vaultAutoLockMinutes).toBe(
      DEFAULT_SETTINGS.vaultAutoLockMinutes
    )
    expect(parseSettings({ vaultAutoLockMinutes: 43201 }).vaultAutoLockMinutes).toBe(
      DEFAULT_SETTINGS.vaultAutoLockMinutes
    )
    expect(parseSettings({ vaultAutoLockMinutes: 10.5 }).vaultAutoLockMinutes).toBe(
      DEFAULT_SETTINGS.vaultAutoLockMinutes
    )
  })
  it('43200분(안 함)은 그대로 허용된다', () => {
    expect(parseSettings({ vaultAutoLockMinutes: 43200 }).vaultAutoLockMinutes).toBe(43200)
  })
  it('문자열 등 잘못된 타입의 기기 기억 값은 기본값(true)으로 되돌아간다', () => {
    expect(parseSettings({ vaultRememberDevice: '켜짐' }).vaultRememberDevice).toBe(true)
    expect(parseSettings({ vaultRememberDevice: 1 }).vaultRememberDevice).toBe(true)
    expect(parseSettings({ vaultAutoLockMinutes: '많이' }).vaultAutoLockMinutes).toBe(
      DEFAULT_SETTINGS.vaultAutoLockMinutes
    )
  })
})

describe('parseSettings — vaultAccessPolicy / vaultAutoSubmit / vaultExcludedHosts', () => {
  it('기본값: while_unlocked · 자동 제출 켬 · 제외 도메인 없음', () => {
    const s = parseSettings({})
    expect(s.vaultAccessPolicy).toBe('while_unlocked')
    expect(s.vaultAutoSubmit).toBe(true)
    expect(s.vaultExcludedHosts).toEqual([])
  })
  it('유효한 값은 그대로 반영된다', () => {
    expect(parseSettings({ vaultAccessPolicy: 'always' }).vaultAccessPolicy).toBe('always')
    expect(parseSettings({ vaultAccessPolicy: 'never' }).vaultAccessPolicy).toBe('never')
    expect(parseSettings({ vaultAutoSubmit: false }).vaultAutoSubmit).toBe(false)
    expect(parseSettings({ vaultExcludedHosts: ['example.com'] }).vaultExcludedHosts).toEqual([
      'example.com'
    ])
  })
  it('잘못된 값은 기본값으로 되돌아간다', () => {
    expect(parseSettings({ vaultAccessPolicy: 'admin' }).vaultAccessPolicy).toBe('while_unlocked')
    expect(parseSettings({ vaultAutoSubmit: 'yes' }).vaultAutoSubmit).toBe(true)
    expect(parseSettings({ vaultExcludedHosts: 'example.com' }).vaultExcludedHosts).toEqual([])
    expect(parseSettings({ vaultExcludedHosts: [1, 2] }).vaultExcludedHosts).toEqual([])
  })
})

// === 홈 주소 / 새 탭 주소 / 검색엔진 (신규 추가분) ============================
describe('parseSettings — homeUrl / newTabUrl / searchEngine', () => {
  it('기본값: 구글 홈, 새 탭은 홈과 동일, 검색엔진은 구글', () => {
    const s = parseSettings({})
    expect(s.homeUrl).toBe(DEFAULT_SETTINGS.homeUrl)
    expect(s.newTabUrl).toBe('home')
    expect(s.searchEngine).toBe('google')
  })
  it('http/https 홈 주소는 그대로 반영된다', () => {
    expect(parseSettings({ homeUrl: 'https://naver.com' }).homeUrl).toBe('https://naver.com')
  })
  it('http/https 가 아닌 홈 주소는 기본값으로 되돌아간다', () => {
    expect(parseSettings({ homeUrl: 'javascript:alert(1)' }).homeUrl).toBe(DEFAULT_SETTINGS.homeUrl)
    expect(parseSettings({ homeUrl: 'about:blank' }).homeUrl).toBe(DEFAULT_SETTINGS.homeUrl)
    expect(parseSettings({ homeUrl: '' }).homeUrl).toBe(DEFAULT_SETTINGS.homeUrl)
  })
  it('newTabUrl/searchEngine 잘못된 값은 기본값으로 되돌아간다', () => {
    expect(parseSettings({ newTabUrl: 'weird' }).newTabUrl).toBe('home')
    expect(parseSettings({ searchEngine: 'bing' }).searchEngine).toBe('google')
  })
})
// === 신규 추가분 끝 ============================================================
