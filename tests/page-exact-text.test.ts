// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { idOfExactText, textOf } from '../src/preload/page-core'

// jsdom 은 크기를 0 으로 준다 — 보이는 칸처럼 크기를 준다
function sized(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 80, bottom: 20, width: 80, height: 20, x: 0, y: 0 }) as DOMRect
  }
}

describe('idOfExactText — 요소 목록에 안 잡히는 칸을 글자로 찾는다', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="grid">
        <div class="row"><div class="cell"><div class="txt">20260101-000001</div></div><div class="cell">A</div></div>
        <div class="row"><div class="cell"><div class="txt">20260101-000002</div></div><div class="cell">A</div></div>
        <div class="row" style="display:none"><div class="cell">20260101-000003</div></div>
      </div>`
    sized()
  })

  it('글자가 정확히 같은 가장 안쪽 요소에 번호를 매긴다', () => {
    const id = idOfExactText('20260101-000002')
    expect(id).toBeGreaterThan(0)
    expect(textOf(id)).toContain('20260101-000002')
  })

  it('같은 글자가 여럿이면 nth 로 고른다', () => {
    const first = idOfExactText('A', 0)
    const second = idOfExactText('A', 1)
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(second).not.toBe(first)
  })

  it('없거나 숨은 글자는 -1', () => {
    expect(idOfExactText('20260101-999999')).toBe(-1)
    expect(idOfExactText('20260101-000003')).toBe(-1)
    expect(idOfExactText('  ')).toBe(-1)
  })
})
