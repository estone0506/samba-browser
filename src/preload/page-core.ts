// [규칙] 이 파일은 page.ts 와 함께 sandbox preload 로 번들된다.
// src/shared/* 에서 **값(value)** 을 import 하지 말 것 — Rollup 청크 분리로 require() 가 생겨
// preload 로드가 실패한다. 타입은 `import type` 만 사용(번들에 남지 않음), 값은 ./page-constants 에서.
import type { PageElement, PageSnapshot } from '../shared/snapshot'
import { MAX_ELEMENTS } from './page-constants'
import {
  detectLoginFields,
  usernameElementFor as detectUsernameElementFor,
  type LoginFields
} from './login-detect'

// 스냅샷 id → 실제 DOM 요소 매핑 (스냅샷마다 갱신)
let registry: HTMLElement[] = []

const SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [contenteditable="true"]'

// jsdom 등 CSS.escape 미지원 환경을 위한 간단한 폴백
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false
  let node: HTMLElement | null = el
  while (node) {
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    node = node.parentElement
  }
  return true
}

function roleOf(el: HTMLElement): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
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

export function buildSnapshot(): PageSnapshot {
  const all = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter(isVisible)
  registry = all.slice(0, MAX_ELEMENTS)
  const elements: PageElement[] = registry.map((el, i) => {
    const input = el as HTMLInputElement
    const inputType = el.tagName === 'INPUT' ? input.type : undefined
    return {
      id: i + 1,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      text: labelOf(el),
      name: input.name || undefined,
      href: (el as HTMLAnchorElement).getAttribute?.('href') || undefined,
      inputType,
      isSecret: inputType === 'password'
    }
  })
  return {
    url: location.href,
    title: document.title,
    text: (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim(),
    elements
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

export function performClick(id: number): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  // jsdom 등 일부 환경은 scrollIntoView 를 구현하지 않음
  el.scrollIntoView?.({ block: 'center' })
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

export function performScroll(dir: 'up' | 'down'): string {
  window.scrollBy({ top: dir === 'down' ? window.innerHeight * 0.8 : -window.innerHeight * 0.8 })
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

// 로그인 필드 탐지. registry 가 비어 있으면(스냅샷을 아직 안 찍었으면) buildSnapshot 을 먼저 호출한다.
// 실제 판정은 login-detect 모듈(Chromium/Bitwarden 규칙 이식)이 담당한다
export function findLoginFields(): LoginFields {
  if (registry.length === 0) buildSnapshot()
  return detectLoginFields(registry)
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
    ).filter(isVisible)
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
      ).filter(isVisible)
      const pw = pwEls[0]
      if (!pw) return
      if (!isRelevantSubmitClick(clicked, pw)) return
      attempt()
    },
    true
  )
}
