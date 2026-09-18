// 페이지 JS 대화상자 자동 처리의 순수 판정 로직 검증(electron 없이 실행된다)

import { describe, it, expect } from 'vitest'
import { decideDialog, formatDialogNote, isAutomationActive } from '../src/main/browser/dialogs'

describe('decideDialog', () => {
  it('자동화가 아닐 때는 손대지 않는다(사람이 직접 쓰는 중)', () => {
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
      expect(decideDialog(type, false)).toEqual({ handle: false, accept: false, ask: false })
    }
  })

  it('alert 는 알림일 뿐이라 어느 모드에서나 닫는다', () => {
    for (const mode of ['read_only', 'guard', 'full'] as const) {
      expect(decideDialog('alert', true, mode)).toEqual({
        handle: true,
        accept: true,
        ask: false
      })
    }
  })

  it('full 모드에서만 confirm/beforeunload 를 자동 확인한다', () => {
    expect(decideDialog('confirm', true, 'full')).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
    expect(decideDialog('beforeunload', true, 'full')).toEqual({
      handle: true,
      accept: true,
      ask: false
    })
  })

  it('guard 모드의 confirm/beforeunload 는 사용자에게 물어본다', () => {
    expect(decideDialog('confirm', true, 'guard')).toEqual({
      handle: true,
      accept: false,
      ask: true
    })
    expect(decideDialog('beforeunload', true, 'guard')).toEqual({
      handle: true,
      accept: false,
      ask: true
    })
  })

  it('read_only 모드의 confirm/beforeunload 는 묻지도 않고 취소한다', () => {
    expect(decideDialog('confirm', true, 'read_only')).toEqual({
      handle: true,
      accept: false,
      ask: false
    })
    expect(decideDialog('beforeunload', true, 'read_only')).toEqual({
      handle: true,
      accept: false,
      ask: false
    })
  })

  it('모드를 주지 않으면 guard 로 본다(자동 확인하지 않는다)', () => {
    expect(decideDialog('confirm', true)).toEqual({ handle: true, accept: false, ask: true })
  })

  it('prompt 는 임의 입력이 되므로 취소한다', () => {
    expect(decideDialog('prompt', true)).toEqual({ handle: true, accept: false, ask: false })
  })
})

describe('isAutomationActive', () => {
  it('AI 작업이 돌면 활성', () => {
    expect(isAutomationActive(true, {})).toBe(true)
  })

  it('e2e 실행 중이면 작업이 없어도 활성', () => {
    expect(isAutomationActive(false, { SAMBA_E2E: '1' })).toBe(true)
    expect(isAutomationActive(false, { SAMBA_E2E: 'true' })).toBe(true)
  })

  it('둘 다 아니면 비활성', () => {
    expect(isAutomationActive(false, {})).toBe(false)
    expect(isAutomationActive(false, { SAMBA_E2E: '0' })).toBe(false)
  })

  it('패키징된 앱에서는 환경변수 스위치를 인정하지 않는다', () => {
    expect(isAutomationActive(false, { SAMBA_E2E: '1' }, false)).toBe(false)
    // AI 작업이 실제로 도는 중이면 그대로 활성이다
    expect(isAutomationActive(true, { SAMBA_E2E: '1' }, false)).toBe(true)
  })
})

describe('formatDialogNote', () => {
  it('공백을 정리해 한 줄 안내로 만든다', () => {
    expect(formatDialogNote('  재고가\n 없습니다.  ')).toBe('page dialog: "재고가 없습니다."')
  })

  it('아주 긴 문구는 잘라 낸다(도구 결과를 밀어내지 않게)', () => {
    const note = formatDialogNote('가'.repeat(1000))
    expect(note.length).toBeLessThan(330)
  })
})
