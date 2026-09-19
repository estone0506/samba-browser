// 캡처 · 영역 선택(웨일 "영역 선택") — 페이지의 DOM 요소를 하나씩 하이라이트하고,
// 클릭하면 그 요소의 경계만 메인에 알려 준다.
//
// 보안 규칙
// - 격리 월드에서만 동작하고, 하이라이트는 Shadow DOM 안에 그린다(페이지가 건드릴 수 없다)
// - 메인으로 나가는 것은 사각형 네 값뿐이다 — 페이지 내용은 담기지 않는다
// - shared/* 의 값은 import 하지 않는다(sandbox preload 규칙, page-constants 참고)

/** 메인으로 보내는 요소 경계(뷰포트 CSS 픽셀) */
export interface CaptureElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionPickerDeps {
  /** 선택한 요소의 경계를 메인으로 보낸다 */
  send: (rect: CaptureElementRect) => void
}

// 하이라이트로 고를 수 없는 요소들(문서 전체를 덮어 의미가 없다)
const SKIP_TAGS = new Set(['HTML', 'BODY'])

/** 요소 경계를 캡처 가능한 정수 사각형으로 다듬는다. 너무 작으면 null */
export function toCaptureRect(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }
): CaptureElementRect | null {
  const left = Math.max(0, Math.floor(rect.left))
  const top = Math.max(0, Math.floor(rect.top))
  const right = Math.min(viewport.width, Math.ceil(rect.left + rect.width))
  const bottom = Math.min(viewport.height, Math.ceil(rect.top + rect.height))
  const width = right - left
  const height = bottom - top
  if (width < 2 || height < 2) return null
  return { x: left, y: top, width, height }
}

/** 하이라이트 대상으로 쓸 수 있는 요소인가 */
export function isRegionTarget(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  return !SKIP_TAGS.has(el.tagName)
}

const STYLE = `
  :host { all: initial; }
  .veil {
    position: fixed; inset: 0; z-index: 2147483647;
    cursor: crosshair; background: rgba(0,0,0,.08);
  }
  .box {
    position: fixed; pointer-events: none;
    border: 2px solid #0a84ff; border-radius: 4px;
    background: rgba(10,132,255,.12);
    box-shadow: 0 0 0 9999px rgba(0,0,0,.18);
    transition: all .06s ease-out;
  }
  .hint {
    position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
    pointer-events: none;
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #fff; background: rgba(0,0,0,.72);
    padding: 6px 12px; border-radius: 999px; white-space: nowrap;
  }
`

interface PickerHandle {
  start: (hint: string) => void
  stop: () => void
}

/**
 * 요소 선택 모드를 설치한다. 돌려주는 핸들의 start/stop 으로 켜고 끈다.
 * 모드가 꺼져 있는 동안에는 페이지에 아무 요소도 붙지 않는다
 */
export function installRegionPicker(deps: RegionPickerDeps): PickerHandle {
  let host: HTMLDivElement | null = null
  let veil: HTMLDivElement | null = null
  let box: HTMLDivElement | null = null
  let hintNode: HTMLDivElement | null = null
  let current: HTMLElement | null = null

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight
  })

  const highlight = (el: HTMLElement | null): void => {
    current = el
    if (!box) return
    if (!el) {
      box.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${r.left}px`
    box.style.top = `${r.top}px`
    box.style.width = `${r.width}px`
    box.style.height = `${r.height}px`
  }

  // 덮개는 포인터를 가로채므로, 그 아래의 실제 요소를 다시 찾는다
  const elementUnder = (x: number, y: number): HTMLElement | null => {
    if (!veil) return null
    veil.style.pointerEvents = 'none'
    const found = document.elementFromPoint(x, y)
    veil.style.pointerEvents = 'auto'
    return isRegionTarget(found) ? found : null
  }

  const onMove = (e: MouseEvent): void => highlight(elementUnder(e.clientX, e.clientY))

  const onClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = current ?? elementUnder(e.clientX, e.clientY)
    stop()
    if (!el) return
    const rect = toCaptureRect(el.getBoundingClientRect(), viewport())
    if (rect) deps.send(rect)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    stop()
  }

  function stop(): void {
    window.removeEventListener('keydown', onKeyDown, true)
    host?.remove()
    host = null
    veil = null
    box = null
    hintNode = null
    current = null
  }

  function start(hint: string): void {
    stop()
    host = document.createElement('div')
    // 페이지 CSS·스크립트가 건드릴 수 없도록 Shadow DOM 안에 그린다
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    veil = document.createElement('div')
    veil.className = 'veil'
    box = document.createElement('div')
    box.className = 'box'
    box.style.display = 'none'
    hintNode = document.createElement('div')
    hintNode.className = 'hint'
    hintNode.textContent = hint
    root.append(style, veil, box, hintNode)
    document.documentElement.appendChild(host)
    veil.addEventListener('mousemove', onMove, true)
    veil.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKeyDown, true)
  }

  return { start, stop }
}

/** 영역 선택 안내 문구(ko/en). 격리 월드에는 i18n 모듈을 쓸 수 없어 여기 둔다 */
export const REGION_HINTS = {
  ko: '캡처할 영역을 클릭하세요 · ESC 취소',
  en: 'Click an area to capture · ESC to cancel'
} as const
