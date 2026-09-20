// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildSnapshot, performClick } from '../src/preload/page-core'

const HTML = `
  <header><a href="/home" id="home">홈</a><button id="cart">장바구니</button></header>
  <section class="OptionArea">
    <button id="size255">255</button>
    <button id="size260">260</button>
    <p>사이즈를 고르세요</p>
  </section>
  <footer><a href="/terms" id="terms">이용약관</a></footer>
`

describe('buildSnapshot selector', () => {
  it('selector 를 주면 그 안쪽 요소만 나열한다', () => {
    document.body.innerHTML = HTML
    const snap = buildSnapshot({ selector: '.OptionArea' })
    expect(snap.elements.map((e) => e.text)).toEqual(['255', '260'])
    expect(snap.total).toBe(2)
  })

  it('나열만 좁힐 뿐 id 는 전체 문서 기준 그대로다', () => {
    document.body.innerHTML = HTML
    const all = buildSnapshot()
    const scoped = buildSnapshot({ selector: '.OptionArea' })
    const idOf = (text: string): number | undefined => all.elements.find((e) => e.text === text)?.id
    expect(scoped.elements.find((e) => e.text === '255')?.id).toBe(idOf('255'))
    expect(scoped.elements.find((e) => e.text === '260')?.id).toBe(idOf('260'))
  })

  it('좁힌 스냅샷의 id 로도 클릭이 된다(registry 는 전체를 유지)', () => {
    document.body.innerHTML = HTML
    let clicked = ''
    document.getElementById('size260')?.addEventListener('click', () => (clicked = '260'))
    const scoped = buildSnapshot({ selector: '.OptionArea' })
    const id = scoped.elements.find((e) => e.text === '260')?.id
    expect(id).toBeDefined()
    performClick(id as number)
    expect(clicked).toBe('260')
  })

  it('본문 텍스트도 selector 범위 안만 담는다', () => {
    document.body.innerHTML = HTML
    const snap = buildSnapshot({ selector: '.OptionArea' })
    expect(snap.text).toContain('사이즈를 고르세요')
    expect(snap.text).not.toContain('이용약관')
  })

  it('selector 와 query 를 함께 주면 둘 다 적용한다', () => {
    document.body.innerHTML = HTML
    const snap = buildSnapshot({ selector: '.OptionArea', query: '255' })
    expect(snap.elements.map((e) => e.text)).toEqual(['255'])
  })

  it('문법에 맞지 않는 selector 는 오류를 알린다', () => {
    document.body.innerHTML = HTML
    const snap = buildSnapshot({ selector: '[[[' })
    expect(snap.selectorError).toContain('invalid selector')
    expect(snap.elements).toEqual([])
  })

  it('아무것도 걸리지 않는 selector 는 빈 목록이다(오류가 아니다)', () => {
    document.body.innerHTML = HTML
    const snap = buildSnapshot({ selector: '.NoSuchArea' })
    expect(snap.selectorError).toBeUndefined()
    expect(snap.elements).toEqual([])
  })
})
