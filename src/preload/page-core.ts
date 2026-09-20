// [규칙] 이 파일은 page.ts 와 함께 sandbox preload 로 번들된다.
// src/shared/* 에서 **값(value)** 을 import 하지 말 것 — Rollup 청크 분리로 require() 가 생겨
// preload 로드가 실패한다. 타입은 `import type` 만 사용(번들에 남지 않음), 값은 ./page-constants 에서.
import type { KeypadSignals, PageElement, PageSnapshot } from '../shared/snapshot'
import { MAX_ELEMENTS } from './page-constants'
import {
  detectLoginFields,
  detectSignedInHint,
  detectCaptchaHint,
  labelTextOf,
  usernameElementFor as detectUsernameElementFor,
  type CaptchaHint,
  type LoginFields,
  type SignedInHint
} from './login-detect'

// 스냅샷 id → 실제 DOM 요소 매핑 (스냅샷마다 갱신)
let registry: HTMLElement[] = []

// 기본 수집 셀렉터. 역할(role)·시맨틱으로 "누를 수 있다"고 선언한 요소들.
// 옵션·탭·메뉴 항목까지 넓힌 이유: 쇼핑몰 상품 페이지의 컬러/사이즈 선택이 대부분 이 부류다
const SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], ' +
  '[contenteditable="true"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], ' +
  '[role="combobox"], [role="listbox"] li, [tabindex]:not([tabindex="-1"]), summary, label[for]'

// --- 커서 휴리스틱 --------------------------------------------------------
// 무신사처럼 role·onclick·tabindex 가 하나도 없는 순수 DIV 에 React 핸들러만 달아 둔 UI 대응.
// CSS 가 cursor:pointer 를 준 "가장 안쪽" 요소만 주워 담는다.
const CURSOR_CANDIDATES = 'div,span,li,p,img,svg'
// 성능 상한: 후보 탐색 개수 / 최종 수집 개수 / 라벨 길이
// 무신사 상품 페이지는 후보가 5천 개를 넘고 옵션 목록이 4,500번째쯤에 온다 — 개수보다 시간으로 막는다
const CURSOR_SCAN_MAX = 30000
const CURSOR_TIME_BUDGET_MS = 120
// 무신사 상품 페이지는 pointer 요소만 1,700개다 — 600이면 옵션 목록 전에 차서 사이즈를 못 고른다
const CURSOR_PICK_MAX = 4000
const CURSOR_TEXT_MAX = 120
// 그 자체로는 의미가 없는 태그들(수집됐다면 클릭 가능해서 잡힌 것이다)
const GENERIC_TAGS = new Set(['div', 'span', 'li', 'p', 'img', 'svg'])

// jsdom 등 CSS.escape 미지원 환경을 위한 간단한 폴백
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

// 한 번의 스냅샷 안에서 같은 조상을 몇 번씩 다시 계산하지 않도록 쓰는 캐시
type VisibilityCache = Map<HTMLElement, boolean>

function isVisible(el: HTMLElement, cache?: VisibilityCache): boolean {
  const cached = cache?.get(el)
  if (cached !== undefined) return cached
  let ok = !el.hidden
  if (ok) {
    const cs = getComputedStyle(el)
    ok = cs.display !== 'none' && cs.visibility !== 'hidden'
  }
  if (ok) {
    const parent = el.parentElement
    ok = parent === null ? true : isVisible(parent, cache)
  }
  cache?.set(el, ok)
  return ok
}

function roleOf(el: HTMLElement, clickable = false): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  // 리스트박스 안의 항목은 드롭다운 선택지다 — 모델이 바로 알아보도록 option 으로 표기
  if (tag === 'li' && el.closest?.('[role="listbox"]')) return 'option'
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type
    if (t === 'submit' || t === 'button') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'textbox'
  }
  // 의미 없는 태그(div/span/…)가 수집됐다는 건 tabindex·onclick·커서 휴리스틱으로 잡혔다는 뜻이다.
  // 모델에게는 태그명보다 "누를 수 있다"가 필요한 정보라 clickable 로 알린다
  if (clickable || GENERIC_TAGS.has(tag)) return 'clickable'
  return tag
}

function labelOf(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.trim()
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text
  // name 속성이 있으면 그 값을 그대로 노출하므로 placeholder 는 name 이 없을 때만 사용
  const name = el.getAttribute('name')
  if (!name) {
    const ph = el.getAttribute('placeholder')
    if (ph) return ph.trim()
  }
  const id = el.id
  if (id) {
    const lab = document.querySelector(`label[for="${cssEscape(id)}"]`)
    if (lab?.textContent) return lab.textContent.trim()
  }
  return ''
}

/** 요소 하나를 스냅샷 항목으로 만든다(id 는 registry 순서 그대로) */
function describeElement(el: HTMLElement, id: number, clickable = false): PageElement {
  const input = el as HTMLInputElement
  const inputType = el.tagName === 'INPUT' ? input.type : undefined
  return {
    id,
    tag: el.tagName.toLowerCase(),
    role: roleOf(el, clickable),
    text: labelOf(el),
    name: input.name || undefined,
    href: (el as HTMLAnchorElement).getAttribute?.('href') || undefined,
    inputType,
    isSecret: inputType === 'password'
  }
}

/** 지금 화면(뷰포트) 안에 들어와 있는 요소인가. 좌표를 못 구하면 false(문서 순으로 밀린다) */
function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect?.()
  if (!rect) return false
  if (rect.width === 0 && rect.height === 0) return false
  const height = window.innerHeight || document.documentElement.clientHeight || 0
  const width = window.innerWidth || document.documentElement.clientWidth || 0
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
}

/** 검색어가 요소의 라벨·name·href·placeholder 에 들어 있는가(대소문자 무시 부분일치) */
function matchesQuery(el: HTMLElement, item: PageElement, query: string): boolean {
  const haystack = [
    item.text,
    item.name ?? '',
    item.href ?? '',
    el.getAttribute('placeholder') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('value') ?? ''
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

/** 문서에 나타나는 순서대로 정렬(jsdom 에도 compareDocumentPosition 은 있다) */
function sortByDocumentOrder(els: HTMLElement[]): HTMLElement[] {
  return els.slice().sort((a, b) => {
    if (a === b) return 0
    const pos = a.compareDocumentPosition(b)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

/** 커서 휴리스틱 후보인가 — 텍스트가 짧게라도 있거나(≤120자) 그림(img/svg)이어야 한다 */
function hasTextLabel(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= CURSOR_TEXT_MAX
}

// 아이콘(img/svg/빈 칸)이 텍스트 있는 pointer 조상 안에 있는가 — 그러면 조상이 항목이다
const ICON_ANCESTOR_DEPTH = 8
function insideTextPointer(el: HTMLElement): boolean {
  let node = el.parentElement
  for (let i = 0; i < ICON_ANCESTOR_DEPTH && node && node !== document.body; i += 1) {
    if (getComputedStyle(node).cursor === 'pointer' && hasTextLabel(node)) return true
    node = node.parentElement
  }
  return false
}

function hasClickableLabel(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'img' || tag === 'svg') return true
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= CURSOR_TEXT_MAX
}

/**
 * CSS 가 cursor:pointer 를 준 순수 DIV/SPAN 류를 줍는다(role·onclick 이 없는 React UI 대응).
 *
 * 규칙
 * - SELECTOR 로 이미 잡힌 요소, 그리고 그런 요소를 품고 있는 요소는 제외한다(가장 안쪽만).
 * - pointer 인 조상-자손이 겹치면 안쪽(= 텍스트가 더 짧은 쪽)만 남긴다.
 * - 성능: 후보 탐색 30000개 또는 120ms, 결과 4000개까지. 비싼 검사(isVisible)는 마지막에 한다.
 */
function collectCursorClickable(base: HTMLElement[]): HTMLElement[] {
  const body = document.body
  if (!body) return []
  // base 와 그 조상들을 미리 표시해 둔다 — 후보마다 querySelector 를 돌리는 것보다 훨씬 싸다
  const blocked = new Set<HTMLElement>(base)
  for (const el of base) {
    let node = el.parentElement
    while (node && !blocked.has(node)) {
      blocked.add(node)
      node = node.parentElement
    }
  }
  const visible: VisibilityCache = new Map()
  const nodes = body.querySelectorAll<HTMLElement>(CURSOR_CANDIDATES)
  const scanned = Math.min(nodes.length, CURSOR_SCAN_MAX)
  const picked: HTMLElement[] = []
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  for (let i = 0; i < scanned; i += 1) {
    if (picked.length >= CURSOR_PICK_MAX) break
    // 시간 예산 — 64개마다 한 번만 시계를 본다
    if ((i & 63) === 63) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (now - startedAt > CURSOR_TIME_BUDGET_MS) break
    }
    const el = nodes[i]
    // 자기 자신이 이미 수집됐거나, 안에 수집된 인터랙티브 요소가 있으면 건너뛴다(가장 안쪽만)
    if (blocked.has(el)) continue
    if (getComputedStyle(el).cursor !== 'pointer') continue
    if (!hasClickableLabel(el)) continue
    if (!isVisible(el, visible)) continue
    // 문서 순서라 조상이 먼저 담긴다 — 텍스트가 있는 자손이 들어오면 조상을 걷어낸다.
    // 단, 자손이 아이콘(img/svg)이나 빈 칸이고 조상에 텍스트가 있으면 조상을 남긴다 —
    // 메뉴 항목 "(19)BLACK" 안의 컬러칩 이미지가 항목 자체를 밀어내던 문제
    if (!hasTextLabel(el) && insideTextPointer(el)) continue
    while (picked.length > 0 && picked[picked.length - 1].contains(el)) picked.pop()
    picked.push(el)
  }
  return picked
}

export interface SnapshotOptions {
  /** 주면 라벨·name·href·placeholder 가 부분일치하는 요소만 나열한다(id 는 그대로) */
  query?: string
}

/**
 * 페이지 스냅샷.
 *
 * registry(= click/type 이 쓰는 id 표)에는 **보이는 요소를 전부** 담는다 —
 * 150개로 잘라 버리면 뒤쪽 버튼(사이즈 선택·장바구니)을 영영 누를 수 없다.
 * 나열(elements)만 MAX_ELEMENTS 개로 자르고, 기본 순서는 "뷰포트 안 먼저, 그다음 문서 순"이다.
 * query 를 주면 일치하는 요소만 원래 id 그대로 돌려준다(find_elements).
 */
export function buildSnapshot(options: SnapshotOptions = {}): PageSnapshot {
  const baseVisible: VisibilityCache = new Map()
  const base = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) =>
    isVisible(el, baseVisible)
  )
  const clickable = collectCursorClickable(base)
  const clickableSet = new Set<HTMLElement>(clickable)
  // 두 목록을 합쳐 문서 순서로 정렬한다(id 가 화면 순서와 어긋나지 않도록)
  const all = clickable.length > 0 ? sortByDocumentOrder(base.concat(clickable)) : base
  // id 는 문서 순서로 매기고 registry 에는 전부 남긴다(나열 순서가 바뀌어도 id 는 안정적이다)
  registry = all
  const described = all.map((el, i) => describeElement(el, i + 1, clickableSet.has(el)))
  const query = options.query?.trim().toLowerCase()
  let picked: PageElement[]
  let total: number
  if (query) {
    const hits = described.filter((item, i) => matchesQuery(all[i], item, query))
    total = hits.length
    picked = hits.slice(0, MAX_ELEMENTS)
  } else {
    // 지금 화면에 보이는 것부터 — 모델이 필요한 버튼을 먼저 만나게 한다
    const inView: PageElement[] = []
    const rest: PageElement[] = []
    described.forEach((item, i) => (isInViewport(all[i]) ? inView : rest).push(item))
    total = described.length
    picked = inView.concat(rest).slice(0, MAX_ELEMENTS)
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim(),
    elements: picked,
    total
  }
}

function get(id: number): HTMLElement | null {
  return registry[id - 1] ?? null
}

// 등록된 요소가 비밀 입력칸(type=password)인지 여부. 최신 스냅샷 기준으로 판단하며,
// registry 에 없는 id 는 false(비밀 입력칸 아님으로 간주 → 호출부가 거부한다)
export function isSecretField(id: number): boolean {
  const el = get(id)
  if (!el) return false
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password'
}

// 등록된 요소의 실제 페이지 텍스트. 위험 행동 판정의 근거(AI 가 준 label 은 신뢰하지 않음)
export function textOf(id: number): string {
  const el = get(id)
  if (!el) return ''
  const parts = [labelOf(el)]
  // 입력칸은 라벨이 비는 경우가 많아 name/placeholder 도 함께 본다
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const name = el.getAttribute('name')
    const ph = el.getAttribute('placeholder')
    if (name) parts.push(name.trim())
    if (ph) parts.push(ph.trim())
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

/** 마우스/포인터 이벤트 한 개를 쏜다(PointerEvent 가 없는 환경은 MouseEvent 로 대체) */
function fireMouseEvent(el: HTMLElement, type: string): void {
  const init = { bubbles: true, cancelable: true, composed: true }
  let ev: Event
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    ev = new PointerEvent(type, init)
  } else if (typeof MouseEvent === 'function') {
    ev = new MouseEvent(type, init)
  } else {
    ev = new Event(type, init)
  }
  el.dispatchEvent(ev)
}

export function performClick(id: number): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  // jsdom 등 일부 환경은 scrollIntoView 를 구현하지 않음
  el.scrollIntoView?.({ block: 'center' })
  // React 합성 이벤트(onPointerDown/onMouseDown 으로만 반응하는 옵션 UI)를 위해
  // 실제 사용자 클릭과 같은 순서로 쏜다. 마지막 click 은 네이티브 기본동작(링크 이동·체크박스
  // 토글)이 살아 있도록 el.click() 으로 낸다
  fireMouseEvent(el, 'pointerdown')
  fireMouseEvent(el, 'mousedown')
  fireMouseEvent(el, 'pointerup')
  fireMouseEvent(el, 'mouseup')
  el.click()
  return 'ok'
}

export function performType(id: number, text: string, submit: boolean): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  const input = el as HTMLInputElement
  if (input.type === 'password') return 'refused: SECRET field. Ask the user to type it.'
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (setter) setter.call(el, text)
  else input.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    ;(el as HTMLInputElement).form?.requestSubmit?.()
  }
  return 'ok'
}

export function performSelect(id: number, value: string): string {
  const el = get(id) as HTMLSelectElement | null
  if (!el) return `element ${id} not found`
  if (el.tagName !== 'SELECT') return 'refused: not a select'
  const opt = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value)
  if (!opt) return `option "${value}" not found`
  el.value = opt.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}

// 요소를 품은 가장 가까운 "스크롤 되는" 상자(overflow auto/scroll + 넘치는 내용)를 찾는다
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    const canScroll =
      /(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1
    if (canScroll) return node
    node = node.parentElement
  }
  return null
}

/**
 * 페이지를 스크롤한다. id 를 주면 그 요소를 품은 스크롤 상자(드롭다운 목록·패널)를
 * 대신 스크롤한다 — 목록 안쪽에 잘린 옵션(사이즈 255 등)을 보이게 하려는 것이다.
 * 스크롤 상자가 없으면 요소를 화면 가운데로 데려온다
 */
export function performScroll(dir: 'up' | 'down', id?: number): string {
  const sign = dir === 'down' ? 1 : -1
  if (id !== undefined) {
    const el = get(id)
    if (!el) return `element ${id} not found (call get_page again)`
    const box = scrollableAncestor(el)
    if (box) {
      box.scrollTop += sign * box.clientHeight * 0.8
      return `ok (scrolled the list containing element ${id})`
    }
    el.scrollIntoView?.({ block: 'center' })
    return `ok (element ${id} is not inside a scrollable list; brought it into view)`
  }
  window.scrollBy({ top: sign * window.innerHeight * 0.8 })
  return 'ok'
}

// --- 값 주입(SECRET 허용) ------------------------------------------------
// 격리 월드에서 메인 프로세스만 호출한다(AI 텍스트 도구인 performType 과 달리 password 를 막지 않음)
export function fillValue(id: number, value: string): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  const input = el as HTMLInputElement
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (setter) setter.call(el, value)
  else input.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}

// --- 로그인 필드 탐지 -----------------------------------------------------

type FormOwner = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement

function formOf(el: HTMLElement): HTMLFormElement | null {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return (el as FormOwner).form
  }
  return null
}

// username 후보 선택은 login-detect 모듈(Chromium/Bitwarden 규칙 이식)에 위임한다
function usernameElementFor(passwordEl: HTMLInputElement): HTMLInputElement | undefined {
  return detectUsernameElementFor(passwordEl)
}

function isSubmitLike(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type === 'submit'
  if (el.tagName === 'BUTTON') return (el as HTMLButtonElement).type !== 'button'
  return false
}

function isButtonish(el: HTMLElement): boolean {
  return (
    el.tagName === 'BUTTON' ||
    (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'submit')
  )
}

const LOGIN_TEXT = /로그인하기|로그인|login|sign in/i

// 로그인 필드 탐지. 호출할 때마다 스냅샷을 새로 구성한다 — SPA 는 클라이언트 라우팅으로 화면이
// 바뀌어도 문서를 새로 만들지 않아 이전 registry 가 낡은 채 남기 때문(E2E 하네스에서 확인된 버그).
// 실제 판정은 login-detect 모듈(Chromium/Bitwarden 규칙 이식)이 담당한다
export function findLoginFields(): LoginFields {
  buildSnapshot()
  return detectLoginFields(registry)
}

// 이미 로그인된 상태인지 힌트를 돌려준다(판정은 login-detect 모듈)
export function signedInHint(): SignedInHint {
  return detectSignedInHint()
}

// 캡차·2FA 징후를 돌려준다. 푸는 것은 언제나 사용자 몫이다
export function captchaHint(): CaptchaHint {
  return detectCaptchaHint()
}

// --- 결제 비밀번호 키패드 신호 ---------------------------------------------

// 문구 판정에만 쓰므로 페이지 텍스트는 앞부분만 본다(결제 팝업은 짧다)
const KEYPAD_TEXT_MAX = 8000
// 결제 비밀번호 칸으로 볼 자릿수 범위(간편결제 PIN 은 보통 4~6자리)
const PIN_MAXLENGTH_MIN = 4
const PIN_MAXLENGTH_MAX = 6

/**
 * 결제 비밀번호 키패드 판정에 필요한 신호만 모은다.
 * 입력칸의 **값은 절대 읽지 않는다** — 있는지·몇 개인지만 센다.
 * 실제 판정은 메인 쪽 순수 함수(main/agent/secret-page.ts)가 한다
 */
export function keypadSignals(): KeypadSignals {
  let digitButtons = 0
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
    const label = (el.textContent ?? '').trim()
    if (label.length !== 1 || label < '0' || label > '9') continue
    if (!isVisible(el)) continue
    digitButtons += 1
  }
  const pinField = Array.from(document.querySelectorAll<HTMLInputElement>('input')).some((el) => {
    // 평문 입력칸(문자 인증번호 등)은 대상이 아니다 — 비밀 입력칸만 본다
    if (el.type !== 'password') return false
    const max = el.maxLength
    const short = max >= PIN_MAXLENGTH_MIN && max <= PIN_MAXLENGTH_MAX
    const numeric = (el.getAttribute('inputmode') ?? '').toLowerCase() === 'numeric'
    // maxlength 가 없어도(-1) 숫자 전용 비밀 입력칸이면 결제 비밀번호로 본다
    return short || (numeric && (max === -1 || max <= PIN_MAXLENGTH_MAX))
  })
  const body = document.body
  const text = ((body?.innerText || body?.textContent) ?? '').replace(/\s+/g, ' ').trim()
  return {
    url: location.href,
    text: text.slice(0, KEYPAD_TEXT_MAX),
    digitButtons,
    pinField
  }
}

// --- 로그인 상태 유지 체크박스 ---------------------------------------------

// "로그인 상태 유지" 류 체크박스 라벨(ko/en). 같은 세션을 오래 유지해 캡차 발생을 줄인다
export const KEEP_SIGNED_IN_RE =
  /로그인\s?상태\s?유지|자동\s?로그인|로그인\s?유지|keep\s?me\s?signed\s?in|keep\s?signed\s?in|remember\s?me|stay\s?signed\s?in|remember\s?this\s?device/i

/** 라벨 문구가 "로그인 상태 유지" 체크박스인지(순수 함수) */
export function matchKeepSignedIn(label: string): boolean {
  return KEEP_SIGNED_IN_RE.test(label)
}

/**
 * 로그인 폼 제출 직전에 "로그인 상태 유지" 체크박스를 켠다.
 * anchorId(비밀번호·제출 버튼)를 주면 그 요소가 속한 form 안에서만 찾고,
 * form 이 없으면 문서 전체에서 찾는다. 이미 켜져 있으면 건드리지 않는다
 */
export function checkKeepSignedIn(anchorId?: number): string {
  const anchor = anchorId === undefined ? null : get(anchorId)
  const form = anchor ? formOf(anchor) : null
  const root: ParentNode = form ?? document
  const boxes = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ).filter((el) => isVisible(el) && !el.disabled)
  for (const box of boxes) {
    const label = labelTextOf(box)
    if (!matchKeepSignedIn(label)) continue
    if (box.checked) return `already: ${label.slice(0, 40)}`
    box.click()
    // click 이 막힌 폼(라벨만 처리하는 커스텀 UI) 대비 — 값과 이벤트를 직접 맞춘다
    if (!box.checked) {
      box.checked = true
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return box.checked ? `checked: ${label.slice(0, 40)}` : 'none'
  }
  return 'none'
}

// 요소의 form 이 있으면 requestSubmit, 없으면 click 으로 제출(둘 다 실제 제출 동작을 유발)
export function submitForm(id: number): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  const form = formOf(el)
  if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
  else el.click()
  return 'ok'
}

// --- 폼 제출 감지(저장 제안) -----------------------------------------------

export interface InstallCaptureListenerOptions {
  // 테스트 전용: jsdom 의 dispatchEvent 는 isTrusted=false 이므로 합성 이벤트도 허용한다.
  // 실제 page.ts 는 이 옵션 없이(옵션 생략 = 신뢰된 이벤트만) 호출해야 한다.
  allowUntrusted?: boolean
}

const CAPTURE_WINDOW_MS = 30_000
const CAPTURE_MAX_PER_WINDOW = 3

// ipcRenderer.send 등 실제 전송 함수는 주입받는다(테스트에서 스텁 가능하도록)
export function installCaptureListener(
  send: (payload: { host: string; username: string; password: string }) => void,
  options: InstallCaptureListenerOptions = {}
): void {
  const allowUntrusted = options.allowUntrusted === true

  // 같은 제출이 submit 과 click 양쪽에서 잡혀 중복 전송되는 것을 짧게 막는다
  let lastSignature = ''
  let lastSentAt = 0

  // 시그니처와 무관하게, 적대 페이지가 서로 다른 값을 반복 주입/제출해 플러딩하는 것을 막는다
  // (호스트당 30초 최대 3회)
  const sentTimestamps: number[] = []
  const withinRateLimit = (now: number): boolean => {
    while (sentTimestamps.length > 0 && now - sentTimestamps[0] >= CAPTURE_WINDOW_MS) {
      sentTimestamps.shift()
    }
    return sentTimestamps.length < CAPTURE_MAX_PER_WINDOW
  }

  const attempt = (): void => {
    const pwEls = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]')
    ).filter((el) => isVisible(el))
    const pw = pwEls[0]
    if (!pw || !pw.value) return // 값이 없으면 저장 제안을 띄우지 않는다
    const userEl = usernameElementFor(pw)
    const username = userEl?.value ?? ''
    const signature = `${username}:${pw.value}`
    const now = Date.now()
    if (signature === lastSignature && now - lastSentAt < 1000) return
    if (!withinRateLimit(now)) return
    lastSignature = signature
    lastSentAt = now
    sentTimestamps.push(now)
    send({ host: location.host, username, password: pw.value })
  }

  // click 이 감지된 password 와 관련된 제출 액션인지 판정한다.
  // - password 가 form 안에 있으면: 그 form 소속의 submit 성격 버튼일 때만
  // - password 가 form 밖이면: findSubmit() 이 로그인 텍스트로 고르는 것과 같은 기준(같은 요소)일 때만
  function isRelevantSubmitClick(clicked: HTMLElement, pw: HTMLInputElement): boolean {
    const pwForm = formOf(pw)
    if (pwForm) {
      return isSubmitLike(clicked) && formOf(clicked) === pwForm
    }
    return isButtonish(clicked) && LOGIN_TEXT.test(labelOf(clicked))
  }

  // 일반적인 폼 제출(캡처 단계 — 페이지 핸들러의 preventDefault 와 무관하게 이벤트는 도달한다)
  document.addEventListener(
    'submit',
    (ev) => {
      if (!allowUntrusted && ev.isTrusted !== true) return
      attempt()
    },
    true
  )
  // SPA 대비: 페이지가 submit 을 아예 막고 클릭만으로 처리하는 경우도 감지
  document.addEventListener(
    'click',
    (ev) => {
      if (!allowUntrusted && ev.isTrusted !== true) return
      const target = ev.target
      if (!(target instanceof HTMLElement)) return
      const clicked = target.closest('button, input[type="submit"]')
      if (!(clicked instanceof HTMLElement)) return
      const pwEls = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="password"]')
      ).filter((el) => isVisible(el))
      const pw = pwEls[0]
      if (!pw) return
      if (!isRelevantSubmitClick(clicked, pw)) return
      attempt()
    },
    true
  )
}

// --- 프레임 채널 동작 실행 -------------------------------------------------
//
// 메인 프로세스는 하위 프레임(iframe)의 격리 월드를 직접 실행할 수 없어서,
// 코드 문자열 대신 미리 정해진 동작 이름만 IPC 로 보낸다. 여기서는 그 이름을
// 이 문서의 함수로 이어 준다 — **자기 document 만** 다루며, 목록에 없는 이름은 무시한다

/** 메인이 보낸 동작 하나를 이 프레임에서 실행한다. 모르는 동작이면 null */
export function runAgentOp(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as {
    op?: unknown
    id?: unknown
    text?: unknown
    value?: unknown
    query?: unknown
    submit?: unknown
    dir?: unknown
  }
  const id = typeof r.id === 'number' ? r.id : 0
  const text = typeof r.text === 'string' ? r.text : ''
  const value = typeof r.value === 'string' ? r.value : ''
  switch (r.op) {
    case 'snapshot':
      return buildSnapshot(typeof r.query === 'string' ? { query: r.query } : {})
    case 'textOf':
      return textOf(id)
    case 'click':
      return performClick(id)
    case 'type':
      return performType(id, text, r.submit === true)
    case 'select':
      return performSelect(id, value)
    case 'scroll':
      return performScroll(
        r.dir === 'up' ? 'up' : 'down',
        typeof r.id === 'number' ? r.id : undefined
      )
    case 'fillValue':
      return fillValue(id, value)
    case 'submitForm':
      return submitForm(id)
    case 'isSecretField':
      return isSecretField(id)
    case 'keypadSignals':
      return keypadSignals()
    default:
      return null
  }
}
