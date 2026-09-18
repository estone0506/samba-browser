// 페이지 JS 대화상자 자동 처리의 순수 판정 로직 검증(electron 없이 실행된다)

import { describe, it, expect } from 'vitest'
import { decideDialog, formatDialogNote, isAutomationActive } from '../src/main/browser/dialogs'

describe('decideDialog', () => {
  it('자동화가 아닐 때는 손대지 않는다(사람이 직접 쓰는 중)', () => {
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
      expect(decideDialog(type, false)).toEqual({ handle: false, accept: false })
    }
  })

  it('작업 실행 중 alert/confirm 은 확인으로 닫는다', () => {
    expect(decideDialog('alert', true)).toEqual({ handle: true, accept: true })
    expect(decideDialog('confirm', true)).toEqual({ handle: true, accept: true })
    expect(decideDialog('beforeunload', true)).toEqual({ handle: true, accept: true })
  })

  it('prompt 는 임의 입력이 되므로 취소한다', () => {
    expect(decideDialog('prompt', true)).toEqual({ handle: true, accept: false })
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
