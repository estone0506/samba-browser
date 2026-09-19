// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot, performClick, performType, textOf } from '../src/preload/page-core'
import { MAX_ELEMENTS, serializeSnapshot } from '../src/shared/snapshot'

/** jsdom 에는 레이아웃이 없어 위치를 직접 심어 준다(뷰포트 우선 정렬 테스트용) */
function stubRect(el: HTMLElement, top: number, bottom: number): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect
}

beforeEach(() => {
  document.body.innerHTML = `
    <h1>제목</h1>
    <a href="/login" id="l">로그인</a>
    <input name="q" placeholder="검색">
    <input type="password" name="pw">
    <button>검색하기</button>
    <div style="display:none"><button>숨김</button></div>
  `
})

describe('buildSnapshot', () => {
  it('보이는 상호작용 요소만 번호 매김', () => {
    const s = buildSnapshot()
    const texts = s.elements.map((e) => e.text || e.name)
    expect(texts).toEqual(['로그인', 'q', 'pw', '검색하기'])
    expect(s.elements[0].id).toBe(1)
  })
  it('password는 isSecret', () => {
    const s = buildSnapshot()
    expect(s.elements.find((e) => e.name === 'pw')?.isSecret).toBe(true)
  })
})

describe('performClick / performType', () => {
  it('id로 클릭', () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('l')!.addEventListener('click', (ev) => {
      ev.preventDefault()
      clicked = true
    })
    expect(performClick(1)).toBe('ok')
    expect(clicked).toBe(true)
  })
  it('비밀 입력칸 입력 거부', () => {
    buildSnapshot()
    expect(performType(3, 'x', false)).toMatch(/SECRET/)
  })
  it('일반 입력칸 입력', () => {
    buildSnapshot()
    expect(performType(2, '삼바웨이브', false)).toBe('ok')
    expect((document.querySelector('[name=q]') as HTMLInputElement).value).toBe('삼바웨이브')
  })
  it('없는 id는 오류', () => {
    buildSnapshot()
    expect(performClick(99)).toMatch(/not found/)
  })
})

describe('textOf', () => {
  it('등록된 요소의 실제 페이지 텍스트 반환', () => {
    buildSnapshot()
    expect(textOf(1)).toBe('로그인')
  })
  it('입력칸은 name·placeholder 를 함께 반환', () => {
    buildSnapshot()
    expect(textOf(2)).toBe('q 검색')
  })
  it('없는 id 는 빈 문자열', () => {
    buildSnapshot()
    expect(textOf(99)).toBe('')
  })
})

// 나열 상한(150개) 뒤의 요소도 누를 수 있어야 한다.
// 무신사 상품 페이지에서 사이즈·장바구니 버튼이 목록에 없어 막혔던 회귀다
describe('많은 요소 — registry 는 전부, 나열만 150개', () => {
  const TOTAL = 200

  beforeEach(() => {
    const buttons = Array.from(
      { length: TOTAL },
      (_, i) => `<button id="b${i}">버튼${i}</button>`
    ).join('')
    document.body.innerHTML = `${buttons}<button id="cart">장바구니</button>`
  })

  it('나열은 150개로 자르되 전체 개수(total)를 함께 알려 준다', () => {
    const s = buildSnapshot()
    expect(s.elements).toHaveLength(MAX_ELEMENTS)
    expect(s.total).toBe(TOTAL + 1)
  })

  it('150 이후 요소도 id 로 클릭할 수 있다', () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('cart')!.addEventListener('click', () => {
      clicked = true
    })
    expect(performClick(TOTAL + 1)).toBe('ok')
    expect(clicked).toBe(true)
  })

  it('query 로 찾으면 원래 id 를 그대로 돌려준다', () => {
    const s = buildSnapshot({ query: '장바구니' })
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0].id).toBe(TOTAL + 1)
    expect(s.elements[0].text).toBe('장바구니')
  })

  it('query 결과도 150개를 넘지 않는다', () => {
    const s = buildSnapshot({ query: '버튼' })
    expect(s.elements).toHaveLength(MAX_ELEMENTS)
    expect(s.total).toBe(TOTAL)
  })
})

describe('query 필터', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a href="/Cart/view">주문</a>
      <input name="SIZE_255" placeholder="사이즈 선택">
      <button>다른 버튼</button>
    `
  })

  it('대소문자를 가리지 않고 라벨·name·href·placeholder 를 본다', () => {
    expect(buildSnapshot({ query: 'cart' }).elements.map((e) => e.id)).toEqual([1])
    expect(buildSnapshot({ query: 'size_255' }).elements.map((e) => e.id)).toEqual([2])
    expect(buildSnapshot({ query: '사이즈' }).elements.map((e) => e.id)).toEqual([2])
    expect(buildSnapshot({ query: '주문' }).elements.map((e) => e.id)).toEqual([1])
  })

  it('일치하는 게 없으면 빈 목록', () => {
    expect(buildSnapshot({ query: '없는말' }).elements).toEqual([])
  })
})

describe('나열 순서 — 뷰포트 안 요소가 먼저', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="far">멀리</button>
      <button id="near">가까이</button>
    `
    // jsdom 은 레이아웃이 없어 getBoundingClientRect 가 전부 0 이다 — 필요한 것만 심는다
    stubRect(document.getElementById('far')!, 5000, 5040)
    stubRect(document.getElementById('near')!, 10, 50)
  })

  it('화면에 보이는 요소를 앞에 두고, id 는 문서 순서를 유지한다', () => {
    const s = buildSnapshot()
    expect(s.elements.map((e) => e.text)).toEqual(['가까이', '멀리'])
    expect(s.elements.map((e) => e.id)).toEqual([2, 1])
  })
})

describe('serializeSnapshot 상한', () => {
  it('잘린 개수와 find_elements 안내를 덧붙인다', () => {
    const elements = Array.from({ length: MAX_ELEMENTS }, (_, i) => ({
      id: i + 1,
      tag: 'button',
      role: 'button',
      text: `버튼${i}`,
      isSecret: false
    }))
    const out = serializeSnapshot({
      url: 'https://shop.example/',
      title: '',
      text: '',
      elements,
      total: MAX_ELEMENTS + 12
    })
    expect(out).toContain('12 more elements not listed')
    expect(out).toContain('find_elements')
  })

  it('전부 나열했으면 안내를 붙이지 않는다', () => {
    const out = serializeSnapshot({
      url: 'https://shop.example/',
      title: '',
      text: '',
      elements: [],
      total: 0
    })
    expect(out).not.toContain('more elements')
  })
})
