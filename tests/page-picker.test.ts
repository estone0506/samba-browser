// @vitest-environment jsdom
// 페이지 내 자동 채움 피커 — 포커스 자동 열기는 신뢰된(isTrusted) 이벤트일 때만 동작한다

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installAutofillPicker, isPickerTarget } from '../src/preload/page-picker'

const LABELS = { locked: '잠김', empty: '없음', title: '계정' }

function setupForm(): HTMLInputElement {
  document.body.innerHTML = `
    <form id="loginForm">
      <input id="userId" type="text" name="userId" placeholder="아이디">
      <input type="password" name="pw">
    </form>
  `
  const input = document.getElementById('userId') as HTMLInputElement
  // jsdom 은 레이아웃을 계산하지 않아 보이지 않는 요소로 취급된다 — 크기를 흉내 낸다
  input.getBoundingClientRect = () => ({ top: 10, left: 10, width: 200, height: 30 }) as DOMRect
  return input
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isPickerTarget', () => {
  it('같은 폼에 비밀번호 칸이 있는 아이디 칸을 대상으로 본다', () => {
    const input = setupForm()
    expect(isPickerTarget(input)).toBe(true)
  })
})

describe('installAutofillPicker — 포커스 자동 열기', () => {
  it('합성(isTrusted=false) 포커스로는 계정 목록을 요청하지 않는다', () => {
    const input = setupForm()
    const listAccounts = vi.fn(async () => ({ outcome: 'ok', accounts: [] }))
    installAutofillPicker({ listAccounts, fill: async () => ({ outcome: 'ok' }), labels: LABELS })

    // 페이지 스크립트가 직접 만들어 쏜 합성 이벤트(isTrusted=false)
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(listAccounts).not.toHaveBeenCalled()
  })

  it('신뢰된 포커스로 간주하면 계정 목록을 요청한다', () => {
    const input = setupForm()
    const listAccounts = vi.fn(async () => ({ outcome: 'ok', accounts: [] }))
    installAutofillPicker(
      { listAccounts, fill: async () => ({ outcome: 'ok' }), labels: LABELS },
      { allowUntrusted: true }
    )

    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(listAccounts).toHaveBeenCalledTimes(1)
  })
})
