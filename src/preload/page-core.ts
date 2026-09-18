import type { PageElement, PageSnapshot } from '../shared/snapshot'
import { MAX_ELEMENTS } from '../shared/snapshot'

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
