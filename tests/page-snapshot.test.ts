// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildSnapshot,
  performClick,
  performScroll,
  performType,
  runAgentOp,
  textOf
} from '../src/preload/page-core'
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
  it('id로 클릭', async () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('l')!.addEventListener('click', (ev) => {
      ev.preventDefault()
      clicked = true
    })
    // preventDefault 는 "페이지가 받아 갔다"는 신호라 폴백 없이 바로 ok
    expect(await performClick(1)).toBe('ok')
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
  it('없는 id는 오류', async () => {
    buildSnapshot()
    expect(await performClick(99)).toMatch(/not found/)
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

  it('150 이후 요소도 id 로 클릭할 수 있다', async () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('cart')!.addEventListener('click', () => {
      clicked = true
      // 화면이 실제로 바뀌어야 폴백 없이 끝난다(장바구니 담김 토스트를 흉내)
      document.body.appendChild(document.createElement('span'))
    })
    expect(await performClick(TOTAL + 1)).toBe('ok')
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

// --- 커서 휴리스틱 --------------------------------------------------------
// jsdom 의 getComputedStyle 은 cursor 를 계산하지 않는다 — data-cursor 속성으로 대신 심는다.
// isVisible 이 보는 display/visibility 도 함께 돌려줘야 한다
const realGetComputedStyle = window.getComputedStyle.bind(window)

function stubCursorStyles(): void {
  window.getComputedStyle = ((el: Element): CSSStyleDeclaration => {
    const hel = el as HTMLElement
    return {
      cursor: hel.dataset?.cursor === 'pointer' ? 'pointer' : 'auto',
      display: hel.style?.display === 'none' ? 'none' : 'block',
      visibility: hel.style?.visibility === 'hidden' ? 'hidden' : 'visible'
    } as unknown as CSSStyleDeclaration
  }) as typeof window.getComputedStyle
}

function restoreComputedStyles(): void {
  window.getComputedStyle = realGetComputedStyle
}

describe('커서 휴리스틱 — role·onclick 없는 클릭 가능한 DIV', () => {
  beforeEach(stubCursorStyles)
  afterEach(restoreComputedStyles)

  it('cursor:pointer 인 DIV 를 role "clickable" 로 줍는다', () => {
    document.body.innerHTML = `
      <div data-cursor="pointer" id="opt">구매옵션(19)BLACK · 255</div>
      <div id="plain">그냥 설명 문구</div>
    `
    const s = buildSnapshot()
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0].role).toBe('clickable')
    expect(s.elements[0].tag).toBe('div')
    expect(s.elements[0].text).toContain('255')
  })

  it('그 DIV 를 id 로 클릭할 수 있다', async () => {
    document.body.innerHTML = '<div data-cursor="pointer" id="opt">BLACK · 255</div>'
    buildSnapshot()
    let clicked = false
    document.getElementById('opt')!.addEventListener('click', () => {
      clicked = true
      document.body.appendChild(document.createElement('span'))
    })
    expect(await performClick(1)).toBe('ok')
    expect(clicked).toBe(true)
  })

  it('img·svg 는 텍스트가 없어도 줍는다', () => {
    document.body.innerHTML = `
      <img data-cursor="pointer" alt="컬러칩">
      <span data-cursor="pointer"></span>
    `
    const s = buildSnapshot()
    expect(s.elements.map((e) => e.tag)).toEqual(['img'])
  })

  it('텍스트가 120자를 넘으면 본문 덩어리로 보고 거른다', () => {
    document.body.innerHTML = `<div data-cursor="pointer">${'가'.repeat(121)}</div>`
    expect(buildSnapshot().elements).toEqual([])
  })

  it('안에 이미 수집된 버튼이 있으면 바깥 DIV 는 거른다', () => {
    document.body.innerHTML = `
      <div data-cursor="pointer"><button>장바구니</button></div>
    `
    const s = buildSnapshot()
    expect(s.elements.map((e) => e.tag)).toEqual(['button'])
  })

  it('항목 안의 아이콘(img)이 pointer 여도 텍스트가 있는 항목을 남긴다', () => {
    // 무신사 컬러 드롭다운: 항목 div > span "(19)BLACK" + 컬러칩 img, 전부 cursor:pointer
    document.body.innerHTML = `
      <div data-cursor="pointer" id="item">
        <span data-cursor="pointer">(19)BLACK</span>
        <div data-cursor="pointer"><img data-cursor="pointer" alt=""></div>
      </div>`
    const s = buildSnapshot()
    const texts = s.elements.map((e) => e.text)
    expect(texts).toContain('(19)BLACK')
    expect(s.elements.some((e) => e.tag === 'img')).toBe(false)
  })

  it('조상·자손이 둘 다 pointer 면 안쪽(텍스트가 짧은 쪽)만 남긴다', () => {
    document.body.innerHTML = `
      <div data-cursor="pointer" id="row">
        <div data-cursor="pointer" id="inner">255</div>
      </div>
    `
    const s = buildSnapshot()
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0].text).toBe('255')
  })

  it('보이지 않는 요소는 줍지 않는다', () => {
    document.body.innerHTML = `
      <div style="display:none"><div data-cursor="pointer">숨김옵션</div></div>
      <div data-cursor="pointer">보임옵션</div>
    `
    expect(buildSnapshot().elements.map((e) => e.text)).toEqual(['보임옵션'])
  })

  it('결과 4000개 상한을 지킨다(후보 5000개)', () => {
    const divs = Array.from(
      { length: 5000 },
      (_, i) => `<div data-cursor="pointer">옵션${i}</div>`
    ).join('')
    document.body.innerHTML = divs
    const started = Date.now()
    const s = buildSnapshot()
    const elapsed = Date.now() - started
    // 수집은 개수 상한(4000)과 시간 예산(120ms) 둘 다로 끊긴다. 테스트를 여럿 동시에 돌리면
    // 시간 예산이 먼저 걸려 4000에 살짝 못 미치므로, 상한이 600 같은 작은 값으로 되돌아가는
    // 회귀(600 등 작은 값)만 잡도록 넉넉한 구간으로 단언한다
    expect(s.total).toBeLessThanOrEqual(4000)
    expect(s.total).toBeGreaterThan(1000)
    // 회귀 방지용 넉넉한 상한(실측은 수 ms 수준)
    expect(elapsed).toBeLessThan(3000)
  })
})

describe('추가 role 수집', () => {
  beforeEach(stubCursorStyles)
  afterEach(restoreComputedStyles)

  it('option·tab·switch·tabindex·summary·label[for] 를 모두 잡는다', () => {
    document.body.innerHTML = `
      <div role="option">255</div>
      <div role="tab">상품정보</div>
      <div role="menuitem">메뉴</div>
      <div role="switch">알림</div>
      <div tabindex="0">포커스 가능</div>
      <div tabindex="-1">포커스 불가</div>
      <summary>더보기</summary>
      <label for="x">라벨</label>
      <input id="x">
    `
    const s = buildSnapshot()
    const roles = s.elements.map((e) => e.role)
    expect(roles).toEqual([
      'option',
      'tab',
      'menuitem',
      'switch',
      'clickable',
      'summary',
      'label',
      'textbox'
    ])
    expect(s.elements.map((e) => e.text)).not.toContain('포커스 불가')
  })

  it('listbox 안의 li 는 role "option" 으로 표기한다', () => {
    document.body.innerHTML = `
      <ul role="listbox"><li>BLACK</li><li>WHITE</li></ul>
      <ul><li>목록 항목</li></ul>
    `
    const s = buildSnapshot()
    expect(s.elements.map((e) => e.role)).toEqual(['option', 'option'])
    expect(s.elements.map((e) => e.text)).toEqual(['BLACK', 'WHITE'])
  })
})

describe('performClick — React 합성 이벤트', () => {
  it('pointerdown·mousedown·mouseup·click 순서로 쏜다', async () => {
    document.body.innerHTML = '<button id="b">사이즈</button>'
    buildSnapshot()
    const seen: string[] = []
    const el = document.getElementById('b')!
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(type, () => seen.push(type))
    }
    // 화면이 바뀌면 Enter 폴백이 돌지 않아 순서가 그대로 남는다
    el.addEventListener('click', () => document.body.appendChild(document.createElement('span')))
    expect(await performClick(1)).toBe('ok')
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  })
})

describe('performScroll — 목록 내부 스크롤', () => {
  beforeEach(() => stubCursorStyles())
  afterEach(() => {
    window.getComputedStyle = realGetComputedStyle
  })

  it('id 를 주면 그 요소를 품은 스크롤 상자를 내린다', () => {
    document.body.innerHTML = `
      <div id="list" data-overflow="auto" style="height:100px">
        <div data-cursor="pointer">230</div>
        <div data-cursor="pointer">255</div>
      </div>`
    const list = document.getElementById('list') as HTMLElement
    // jsdom 은 레이아웃이 없어 scrollHeight/clientHeight 를 직접 심는다
    Object.defineProperty(list, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true })
    const orig = window.getComputedStyle
    window.getComputedStyle = ((el: Element) => ({
      ...(orig(el) as unknown as Record<string, string>),
      overflowY: (el as HTMLElement).dataset?.overflow ?? 'visible'
    })) as unknown as typeof window.getComputedStyle
    const s = buildSnapshot()
    const item = s.elements.find((e) => e.text === '230')
    expect(item).toBeDefined()
    if (!item) return
    expect(performScroll('down', item.id)).toContain('scrolled the list')
    expect(list.scrollTop).toBe(80)
  })

  it('없는 id 면 안내를 돌려준다', () => {
    document.body.innerHTML = '<div data-cursor="pointer">x</div>'
    buildSnapshot()
    expect(performScroll('down', 999)).toContain('not found')
  })
})

describe('프레임 채널 동작 실행(runAgentOp)', () => {
  // iframe 안 preload 는 코드 문자열이 아니라 동작 이름만 받아 자기 문서에서 실행한다
  it('snapshot 동작은 이 문서의 스냅샷을 돌려준다', () => {
    document.body.innerHTML = '<button>우편번호 검색</button>'
    const s = runAgentOp({ op: 'snapshot', reqId: 1 }) as { elements: { text: string }[] }
    expect(s.elements.map((e) => e.text)).toEqual(['우편번호 검색'])
  })

  it('query 를 주면 걸러낸다', () => {
    document.body.innerHTML = '<button>검색</button><button>닫기</button>'
    const s = runAgentOp({ op: 'snapshot', query: '닫기', reqId: 2 }) as {
      elements: { text: string }[]
    }
    expect(s.elements.map((e) => e.text)).toEqual(['닫기'])
  })

  it('click·type 동작이 실제 요소에 닿는다', async () => {
    document.body.innerHTML = '<input type="text"><button>검색</button>'
    const s = runAgentOp({ op: 'snapshot', reqId: 3 }) as {
      elements: { id: number; tag: string }[]
    }
    const input = s.elements.find((e) => e.tag.toLowerCase() === 'input')
    const button = s.elements.find((e) => e.tag.toLowerCase() === 'button')
    expect(input && button).toBeTruthy()
    if (!input || !button) return
    runAgentOp({ op: 'type', id: input.id, text: '서울시 강남구', submit: false, reqId: 4 })
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('서울시 강남구')
    let clicked = false
    document.querySelector('button')?.addEventListener('click', (ev) => {
      ev.preventDefault()
      clicked = true
    })
    await runAgentOp({ op: 'click', id: button.id, reqId: 5 })
    expect(clicked).toBe(true)
  })

  it('모르는 동작과 망가진 요청은 무시한다', () => {
    expect(runAgentOp({ op: 'deleteEverything', reqId: 6 })).toBeNull()
    expect(runAgentOp(null)).toBeNull()
    expect(runAgentOp('__samba.click(1)')).toBeNull()
  })
})

describe('href 없는 앵커', () => {
  it('JS 버튼으로 쓰는 <a> 도 목록에 담는다', () => {
    document.body.innerHTML = '<a class="add">배송지 추가하기</a>'
    const s = buildSnapshot()
    expect(s.elements.map((e) => e.text)).toContain('배송지 추가하기')
  })
})
