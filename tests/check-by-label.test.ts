// @vitest-environment jsdom
// 라벨 글자로 체크박스 켜기 — 페이코 PC 결제창 '전체 동의'(숨은 체크박스 + 라벨)
import { describe, it, expect, beforeEach } from 'vitest'
import { checkByLabel } from '../src/preload/page-core'

beforeEach(() => {
  document.body.innerHTML = `
    <span class="checkbox-applied" id="form_AllAgree"><span class="checkbox-mark"></span>
      <input type="checkbox" id="form_AllAgree_ckb" style="display:none"></span>
    <label for="form_AllAgree_ckb">전체 동의</label>`
})

describe('checkByLabel', () => {
  it('라벨 글자로 숨은 체크박스를 켠다', () => {
    expect(checkByLabel('전체 동의')).toBe('checked')
    expect((document.getElementById('form_AllAgree_ckb') as HTMLInputElement).checked).toBe(true)
  })
  it('이미 켜져 있으면 누르지 않는다(누르면 꺼진다)', () => {
    checkByLabel('전체 동의')
    expect(checkByLabel('전체 동의')).toBe('already')
    expect((document.getElementById('form_AllAgree_ckb') as HTMLInputElement).checked).toBe(true)
  })
  it('글자가 다르면 not-found', () => {
    expect(checkByLabel('개인정보 동의')).toBe('not-found')
  })
})
