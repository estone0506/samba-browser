// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isOverlay,
  isCloseLabel,
  isSensitiveOverlay,
  OVERLAY_COVERAGE_MIN,
  OVERLAY_Z_MIN
} from '../src/preload/page-overlay'
import {
  buildSnapshot,
  detectOverlays,
  performClick,
  rectOf,
  coveredByNote,
  baselineChanged,
  readClickBaseline,
  CLICK_NO_CHANGE_NOTE
} from '../src/preload/page-core'

// jsdom 에는 레이아웃이 없다. 오버레이 판정에 필요한 값(position·z-index·크기)을 직접 심는다
const realGetComputedStyle = window.getComputedStyle

/** data-pos / data-z 속성을 computed style 로 흉내낸다 */
function stubOverlayStyles(): void {
  window.getComputedStyle = ((el: Element) => {
    const base = realGetComputedStyle(el) as unknown as Record<string, string>
    const ds = (el as HTMLElement).dataset ?? {}
    return {
      ...base,
      display: base.display,
      visibility: base.visibility,
      cursor: ds.cursor ?? 'auto',
      position: ds.pos ?? 'static',
      zIndex: ds.z ?? 'auto'
    }
  }) as unknown as typeof window.getComputedStyle
}

/** 요소가 뷰포트의 ratio 만큼을 덮는다고 심는다 */
function stubCoverage(el: HTMLElement, ratio: number): void {
  const w = window.innerWidth
  const h = window.innerHeight * ratio
  el.getBoundingClientRect = (): DOMRect =>
    ({
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }) as DOMRect
}

describe('오버레이 판정 규칙(순수 함수)', () => {
  const base = { role: '', ariaModal: false, position: 'static', zIndex: 0, coverage: 0 }

  it('role=dialog·alertdialog 는 크기와 무관하게 레이어다', () => {
    expect(isOverlay({ ...base, role: 'dialog' })).toBe(true)
    expect(isOverlay({ ...base, role: 'alertdialog' })).toBe(true)
    expect(isOverlay({ ...base, role: 'AlertDialog' })).toBe(true)
  })

  it('aria-modal 도 레이어다', () => {
    expect(isOverlay({ ...base, ariaModal: true })).toBe(true)
  })

  it('fixed 이면서 30% 이상을 덮고 z-index 가 커야 레이어다', () => {
    const fixed = { ...base, position: 'fixed', zIndex: OVERLAY_Z_MIN, coverage: 0.5 }
    expect(isOverlay(fixed)).toBe(true)
    expect(isOverlay({ ...fixed, position: 'sticky' })).toBe(true)
    // 면적이 모자라면 아니다(작은 고정 버튼·토스트)
    expect(isOverlay({ ...fixed, coverage: OVERLAY_COVERAGE_MIN - 0.01 })).toBe(false)
    // z-index 가 낮으면 아니다
    expect(isOverlay({ ...fixed, zIndex: OVERLAY_Z_MIN - 1 })).toBe(false)
    // 흐름 안에 있는 큰 배너는 화면을 덮지 않는다
    expect(isOverlay({ ...fixed, position: 'relative' })).toBe(false)
  })
})

describe('닫기 후보 라벨', () => {
  it('닫기 문구를 알아본다', () => {
    for (const label of [
      '닫기',
      'Close',
      'CLOSE',
      '확인',
      '오늘 하루 보지 않기',
      '다시 보지 않기',
      '그만 보기',
      '나중에',
      'X',
      '×'
    ]) {
      expect(isCloseLabel(label)).toBe(true)
    }
  })

  it('본문·엉뚱한 버튼은 닫기가 아니다', () => {
    expect(isCloseLabel('구매하기')).toBe(false)
    expect(isCloseLabel('')).toBe(false)
    expect(isCloseLabel('   ')).toBe(false)
    expect(isCloseLabel('지금 앱을 설치하면 첫 구매 10% 할인 쿠폰을 드립니다')).toBe(false)
  })
})

describe('민감 레이어 판정', () => {
  it('결제·비밀번호·로그인·인증은 대신 닫지 않는다', () => {
    expect(isSensitiveOverlay('결제 확인')).toBe(true)
    expect(isSensitiveOverlay('비밀번호를 입력하세요')).toBe(true)
    expect(isSensitiveOverlay('Enter your PIN')).toBe(true)
    expect(isSensitiveOverlay('로그인이 필요합니다')).toBe(true)
    expect(isSensitiveOverlay('휴대폰 본인인증')).toBe(true)
  })

  it('공지·쿠폰 레이어는 민감하지 않다', () => {
    expect(isSensitiveOverlay('브랜드 공지 — 배송 지연 안내')).toBe(false)
    expect(isSensitiveOverlay('앱에서 구매하면 쿠폰 지급')).toBe(false)
  })
})

describe('detectOverlays — 문서에서 찾기', () => {
  beforeEach(() => stubOverlayStyles())
  afterEach(() => {
    window.getComputedStyle = realGetComputedStyle
  })

  it('공지 모달과 닫기 후보 id 를 돌려준다', () => {
    document.body.innerHTML = `
      <button id="buy">구매하기</button>
      <div id="notice" role="dialog">
        <h2>브랜드 배송 공지</h2>
        <button>오늘 하루 보지 않기</button>
        <button>자세히 보기</button>
      </div>`
    const list = detectOverlays()
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('브랜드 배송 공지')
    expect(list[0].sensitive).toBe(false)
    // 닫기 후보는 '오늘 하루 보지 않기' 하나뿐이다
    const snapshot = buildSnapshot()
    const close = snapshot.elements.find((e) => e.text === '오늘 하루 보지 않기')
    expect(list[0].closeIds).toEqual([close?.id])
  })

  it('fixed 전면 배너도 면적·z-index 가 크면 잡는다', () => {
    document.body.innerHTML = `
      <div id="sheet" data-pos="fixed" data-z="9999" aria-label="앱 설치 안내">
        <button>앱으로 보기</button>
        <button aria-label="close">✕</button>
      </div>`
    stubCoverage(document.getElementById('sheet') as HTMLElement, 0.6)
    const list = detectOverlays()
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('앱 설치 안내')
    expect(list[0].closeIds).toHaveLength(1)
  })

  it('작은 고정 요소(플로팅 버튼)는 레이어가 아니다', () => {
    document.body.innerHTML = '<div id="fab" data-pos="fixed" data-z="50">맨 위로</div>'
    stubCoverage(document.getElementById('fab') as HTMLElement, 0.05)
    expect(detectOverlays()).toEqual([])
  })

  it('결제 확인 모달은 sensitive 로 표시만 하고 닫기 후보를 내놓지 않는다', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <h2>결제 비밀번호 확인</h2>
        <button>닫기</button>
      </div>`
    const list = detectOverlays()
    expect(list).toHaveLength(1)
    expect(list[0].sensitive).toBe(true)
    expect(list[0].closeIds).toEqual([])
  })

  it('배경 dim 과 모달이 겹치면 안쪽 모달만 남긴다', () => {
    document.body.innerHTML = `
      <div id="dim" data-pos="fixed" data-z="1000">
        <div id="modal" role="dialog">
          <h2>쿠폰 받기</h2>
          <button>닫기</button>
        </div>
      </div>`
    stubCoverage(document.getElementById('dim') as HTMLElement, 1)
    const list = detectOverlays()
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('쿠폰 받기')
  })

  it('레이어가 없으면 빈 목록', () => {
    document.body.innerHTML = '<button>구매하기</button>'
    expect(detectOverlays()).toEqual([])
  })
})

describe('coveredByNote — 클릭 좌표를 가린 요소', () => {
  it('다른 요소가 좌표를 차지하면 covered by 를 돌려준다', () => {
    document.body.innerHTML = `
      <button id="buy">구매하기</button>
      <div id="dim" class="modal-dim extra"></div>`
    const buy = document.getElementById('buy') as HTMLElement
    stubCoverage(buy, 0.2)
    document.elementFromPoint = (): Element => document.getElementById('dim') as Element
    expect(coveredByNote(buy)).toBe('covered by div.modal-dim')
    delete (document as Partial<Document>).elementFromPoint
  })

  it('자기 자신·자손이 잡히면 가려진 것이 아니다', () => {
    document.body.innerHTML = '<button id="buy"><span id="ico">구매</span></button>'
    const buy = document.getElementById('buy') as HTMLElement
    stubCoverage(buy, 0.2)
    document.elementFromPoint = (): Element => document.getElementById('ico') as Element
    expect(coveredByNote(buy)).toBeNull()
    delete (document as Partial<Document>).elementFromPoint
  })

  it('elementFromPoint 가 없으면 판단하지 않는다', () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    const buy = document.getElementById('buy') as HTMLElement
    stubCoverage(buy, 0.2)
    expect(coveredByNote(buy)).toBeNull()
  })
})

describe('클릭 기준값 비교', () => {
  it('아무 값도 안 바뀌면 변화 없음', () => {
    document.body.innerHTML = '<button id="b">구매하기</button>'
    const el = document.getElementById('b') as HTMLElement
    const before = readClickBaseline(el)
    expect(baselineChanged(before, readClickBaseline(el))).toBe(false)
  })

  it('body 자식이 늘거나 class 가 바뀌면 변화로 본다', () => {
    document.body.innerHTML = '<button id="b">구매하기</button>'
    const el = document.getElementById('b') as HTMLElement
    const before = readClickBaseline(el)
    el.setAttribute('class', 'selected')
    expect(baselineChanged(before, readClickBaseline(el))).toBe(true)
  })
})

describe('performClick 폴백 — 첫 클릭이 먹지 않으면 Enter', () => {
  it('클릭에 반응 없는 버튼에 keydown Enter 를 쏜다', async () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    const el = document.getElementById('buy') as HTMLElement
    const keys: string[] = []
    // 클릭에는 아무 반응이 없고 Enter 로만 열리는 버튼(무신사 '구매하기')
    el.addEventListener('keydown', (ev) => {
      keys.push(`keydown:${(ev as KeyboardEvent).key}`)
      document.body.appendChild(document.createElement('div'))
    })
    el.addEventListener('keyup', (ev) => keys.push(`keyup:${(ev as KeyboardEvent).key}`))
    const r = await performClick(1)
    expect(keys).toContain('keydown:Enter')
    expect(keys).toContain('keyup:Enter')
    expect(r).toContain('via Enter')
    expect(document.activeElement).toBe(el)
  })

  it('Enter 에도 변화가 없으면 오버레이를 의심하라고 알린다', async () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    const r = await performClick(1)
    expect(r).toContain(CLICK_NO_CHANGE_NOTE)
  })

  it('첫 클릭으로 화면이 바뀌면 Enter 를 쏘지 않는다', async () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    const el = document.getElementById('buy') as HTMLElement
    const keys: string[] = []
    el.addEventListener('keydown', (ev) => keys.push((ev as KeyboardEvent).key))
    el.addEventListener('click', () => document.body.appendChild(document.createElement('div')))
    expect(await performClick(1)).toBe('ok')
    expect(keys).toEqual([])
  })
})

/** 요소의 화면 위치·크기를 직접 심는다(jsdom 에는 레이아웃이 없다) */
function stubRect(el: HTMLElement, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({})
    }) as DOMRect
}

describe('performClick 폴백 — 좌표 기준 클릭', () => {
  afterEach(() => {
    delete (document as Partial<Document>).elementFromPoint
  })

  it('버튼을 가린 요소(결과 행)에 좌표 클릭을 보내 선택이 된다', async () => {
    // 롯데온 주소 검색: '사용' 버튼을 눌러도 사이트는 결과 행의 핸들러로만 선택을 처리한다
    document.body.innerHTML = `
      <li id="row" class="result">서울시 중구</li>
      <button id="use">사용</button>`
    buildSnapshot()
    const use = document.getElementById('use') as HTMLElement
    const row = document.getElementById('row') as HTMLElement
    stubRect(use, 100, 200, 40, 20)
    document.elementFromPoint = (): Element => row
    let picked = 0
    row.addEventListener('click', () => {
      picked += 1
      document.body.appendChild(document.createElement('div'))
    })
    const id = buildSnapshot().elements.find((e) => e.text === '사용')?.id as number
    const r = await performClick(id)
    expect(picked).toBe(1)
    expect(r).toContain('via point click on li')
  })

  it('가려져 있지 않으면 대상 자신에게 좌표를 담아 다시 보낸다', async () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    const el = document.getElementById('buy') as HTMLElement
    stubRect(el, 10, 20, 100, 40)
    document.elementFromPoint = (): Element => el
    const seen: { type: string; x: number; y: number; button: number; buttons: number }[] = []
    let coordClicks = 0
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(type, (ev) => {
        const m = ev as MouseEvent
        seen.push({ type, x: m.clientX, y: m.clientY, button: m.button, buttons: m.buttons })
        // 좌표가 실린 클릭에만 반응하는 버튼
        if (type === 'click' && m.clientX > 0) {
          coordClicks += 1
          document.body.appendChild(document.createElement('div'))
        }
      })
    }
    const r = await performClick(1)
    expect(coordClicks).toBe(1)
    expect(r).toContain('via point click')
    // 1차 클릭은 좌표가 없고(0), 폴백 클릭에는 요소 가운데 좌표가 실린다
    const withPoint = seen.filter((e) => e.x === 60 && e.y === 40)
    expect(withPoint.map((e) => e.type)).toEqual([
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click'
    ])
    expect(withPoint.every((e) => e.button === 0)).toBe(true)
    expect(withPoint.find((e) => e.type === 'mousedown')?.buttons).toBe(1)
    expect(withPoint.find((e) => e.type === 'mouseup')?.buttons).toBe(0)
  })
})

describe('rectOf — 실제 마우스 클릭을 보낼 좌표', () => {
  it('요소 가운데의 뷰포트 좌표를 돌려준다', () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    stubRect(document.getElementById('buy') as HTMLElement, 30, 41, 101, 20)
    expect(rectOf(1)).toEqual({ x: 81, y: 51 })
  })

  it('요소가 없거나 크기가 0 이면 null', () => {
    document.body.innerHTML = '<button id="buy">구매하기</button>'
    buildSnapshot()
    expect(rectOf(1)).toBeNull()
    expect(rectOf(9999)).toBeNull()
  })
})

describe('투명 덮개 감지', () => {
  const base = { role: '', ariaModal: false, position: 'fixed', zIndex: 0, coverage: 0.9 }

  it('배경이 투명해도 클릭을 가로채는 fixed 층은 레이어다', () => {
    expect(isOverlay({ ...base, transparentBg: true, pointerEvents: 'auto' })).toBe(true)
  })

  it('pointer-events:none 인 투명 층은 클릭을 막지 않는다', () => {
    expect(isOverlay({ ...base, transparentBg: true, pointerEvents: 'none' })).toBe(false)
  })

  it('배경이 있는 낮은 z-index 층은 예전 규칙 그대로다', () => {
    expect(isOverlay({ ...base, transparentBg: false, pointerEvents: 'auto' })).toBe(false)
  })
})
