// 화면(페이지) 번역과 이미지 번역 오버레이 — 격리 월드에서만 동작한다.
//
// 보안 규칙
// - 수집 대상은 **화면에 그려지는 텍스트 노드**뿐이다. input/textarea/select 의 값과
//   비밀번호 칸은 DOM 텍스트가 아니므로 애초에 수집 경로에 들어오지 않는다.
// - 원문은 감싼 span 의 data-samba-orig 에 남겨 두고, [원문 보기] 로 그대로 되돌린다.
// - 오버레이 UI 는 Shadow DOM 안에 그려 페이지 CSS·스크립트가 건드릴 수 없게 한다.
// - 이 파일은 page.ts 와 같은 엔트리에 인라인되므로 shared 의 **값**을 import 하지 않는다
//   (상수 사본은 ./page-constants.ts).

import { TRANSLATE_CONCURRENCY, TRANSLATE_MAX_CHARS, TRANSLATE_MAX_NODES } from './page-constants'

/** 원문을 담아 두는 감싸개 표식 */
export const ORIG_ATTR = 'data-samba-orig'

/** 번역 대상에서 통째로 제외하는 태그 */
const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'IFRAME',
  'CANVAS',
  'SVG',
  'CODE',
  'PRE',
  'KBD',
  'SAMP'
])

/** 글자가 하나도 없는(기호·숫자·공백뿐인) 텍스트는 번역하지 않는다 */
const HAS_LETTER = /\p{L}/u

export function isSkippedTag(tag: string): boolean {
  return SKIPPED_TAGS.has(tag.toUpperCase())
}

/** 이 요소 아래 텍스트를 번역해도 되는가(편집 중인 영역·제외 태그·이미 감싼 것은 제외) */
export function isTranslatableParent(el: Element | null): boolean {
  let node: Element | null = el
  while (node) {
    if (isSkippedTag(node.tagName)) return false
    if (node.hasAttribute(ORIG_ATTR)) return false
    if (node.getAttribute('contenteditable') === 'true') return false
    if (node.getAttribute('translate') === 'no') return false
    if (node.getAttribute('aria-hidden') === 'true') return false
    node = node.parentElement
  }
  return true
}

/** 번역 대상 텍스트 노드인가 */
export function isTranslatableTextNode(node: Text): boolean {
  const text = node.nodeValue ?? ''
  if (!text.trim()) return false
  if (!HAS_LETTER.test(text)) return false
  return isTranslatableParent(node.parentElement)
}

/**
 * 문서에서 번역 대상 텍스트 노드를 모은다.
 * 화면 밖 노드도 함께 모으고, 실제 번역 시점은 IntersectionObserver 가 정한다
 */
export function collectTextNodes(root: ParentNode = document.body): Text[] {
  const out: Text[] = []
  const owner = (root as Node).ownerDocument ?? document
  const walker = owner.createTreeWalker(root as Node, 4 /* NodeFilter.SHOW_TEXT */)
  let current = walker.nextNode()
  while (current) {
    const text = current as Text
    if (isTranslatableTextNode(text)) out.push(text)
    current = walker.nextNode()
  }
  return out
}

/**
 * 텍스트 노드를 원문 보존용 span 으로 감싼다.
 * 감싼 span 의 textContent 만 번역문으로 갈아 끼우면 되고, 복원은 원문을 되돌려 놓는다
 */
export function wrapTextNodes(nodes: readonly Text[]): HTMLElement[] {
  const wrapped: HTMLElement[] = []
  for (const node of nodes) {
    const parent = node.parentNode
    if (!parent) continue
    const owner = node.ownerDocument ?? document
    const span = owner.createElement('span')
    span.setAttribute(ORIG_ATTR, node.nodeValue ?? '')
    // 페이지 레이아웃을 흔들지 않도록 인라인 그대로 두고 상속만 강제한다
    span.style.all = 'inherit'
    parent.replaceChild(span, node)
    span.appendChild(node)
    wrapped.push(span)
  }
  return wrapped
}

/** [원문 보기] — 감싼 span 을 전부 원문 텍스트 노드로 되돌린다. 되돌린 개수를 반환 */
export function restoreOriginals(root: ParentNode = document.body): number {
  const targets = Array.from(root.querySelectorAll(`[${ORIG_ATTR}]`))
  for (const el of targets) {
    const orig = el.getAttribute(ORIG_ATTR) ?? ''
    const owner = el.ownerDocument ?? document
    el.replaceWith(owner.createTextNode(orig))
  }
  return targets.length
}

/**
 * 번역 요청 배치 분할. 한 배치는 최대 maxNodes 개, 텍스트 합계 maxChars 자를 넘지 않는다.
 * 한 항목이 혼자서 maxChars 를 넘으면 그 항목만 담은 배치가 된다(버리지 않는다)
 */
export function splitBatches(
  texts: readonly string[],
  maxNodes: number = TRANSLATE_MAX_NODES,
  maxChars: number = TRANSLATE_MAX_CHARS
): number[][] {
  const batches: number[][] = []
  let current: number[] = []
  let chars = 0
  for (let i = 0; i < texts.length; i++) {
    const length = texts[i].length
    const overflow = current.length >= maxNodes || (current.length > 0 && chars + length > maxChars)
    if (overflow) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(i)
    chars += length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 할 일들을 최대 limit 개씩만 동시에 돌린다.
 * 하나가 끝나면 바로 다음 것을 집어 가므로, 결과는 도착하는 대로 화면에 반영된다.
 * 개별 할 일이 던진 오류는 삼키고 나머지를 계속 돌린다(배치 하나가 실패해도 페이지 전체가 멈추지 않는다)
 */
export async function runWithLimit(
  tasks: readonly (() => Promise<void>)[],
  limit: number = TRANSLATE_CONCURRENCY
): Promise<void> {
  const size = Math.max(1, Math.floor(limit))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next
      next += 1
      try {
        await tasks[index]()
      } catch {
        // 실패 사유는 호출부(진행률 보고)가 이미 들고 있다
      }
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(size, tasks.length); i++) workers.push(worker())
  await Promise.all(workers)
}

/**
 * 화면에 보이는 요소를 위에서 아래(같은 높이면 왼쪽부터) 순서로 세운다.
 * IntersectionObserver 가 넘겨 주는 순서는 정해져 있지 않아서 여기서 한 번 정렬한다
 */
export function sortByViewportOrder<T>(
  items: readonly T[],
  positionOf: (item: T) => { top: number; left: number }
): T[] {
  return items
    .map((item, index) => ({ item, index, pos: positionOf(item) }))
    .sort((a, b) => a.pos.top - b.pos.top || a.pos.left - b.pos.left || a.index - b.index)
    .map((v) => v.item)
}

// === 이미지 번역 오버레이 ===================================================

export interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ImageBoxLike {
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface NaturalSize {
  width: number
  height: number
}

/**
 * 원본 이미지 픽셀 좌표 → 화면에 그릴 문서 좌표로 환산한다.
 * rect 는 이미지의 getBoundingClientRect(), scroll 은 현재 스크롤 오프셋이다
 */
export function mapImageBox(
  box: ImageBoxLike,
  natural: NaturalSize,
  rect: OverlayRect,
  scroll: { x: number; y: number } = { x: 0, y: 0 }
): OverlayRect {
  if (!(natural.width > 0) || !(natural.height > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scaleX = rect.width / natural.width
  const scaleY = rect.height / natural.height
  return {
    left: rect.left + scroll.x + box.x * scaleX,
    top: rect.top + scroll.y + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY
  }
}

/** 상자 높이에 맞춘 글자 크기(너무 작거나 크지 않게 묶는다) */
export function overlayFontSize(boxHeight: number): number {
  return Math.max(10, Math.min(28, Math.round(boxHeight * 0.72)))
}

const OVERLAY_STYLE = `
  :host { all: initial; }
  .box {
    position: absolute; display: flex; align-items: center; justify-content: center;
    box-sizing: border-box; padding: 0 2px; overflow: hidden;
    background: rgba(255,255,255,.88); color: #111; border-radius: 4px;
    font-family: system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif;
    line-height: 1.15; text-align: center; white-space: pre-wrap; word-break: break-word;
    z-index: 2147483646;
  }
  .close {
    position: absolute; width: 24px; height: 24px; display: flex;
    align-items: center; justify-content: center; border: 0; cursor: pointer;
    border-radius: 999px; background: #111; color: #fff;
    font: 600 13px/1 system-ui, sans-serif; z-index: 2147483647;
  }
`

export interface ImageOverlayDto {
  src: string
  naturalWidth: number
  naturalHeight: number
  boxes: ImageBoxLike[]
}

/** 페이지에서 같은 이미지를 다시 찾는다(우클릭 시점의 src 기준) */
export function findImageBySrc(src: string, root: ParentNode = document): HTMLImageElement | null {
  const images = Array.from(root.querySelectorAll('img'))
  return images.find((img) => img.currentSrc === src || img.src === src) ?? null
}

interface OverlayHandle {
  show: (dto: ImageOverlayDto) => string
  hide: () => void
}

function createImageOverlay(): OverlayHandle {
  let host: HTMLDivElement | null = null
  let root: ShadowRoot | null = null
  let target: HTMLImageElement | null = null
  let current: ImageOverlayDto | null = null
  let boxes: HTMLDivElement[] = []
  let close: HTMLButtonElement | null = null

  const place = (): void => {
    if (!target || !current) return
    const r = target.getBoundingClientRect()
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height }
    const scroll = { x: window.scrollX, y: window.scrollY }
    const natural = { width: current.naturalWidth, height: current.naturalHeight }
    current.boxes.forEach((box, i) => {
      const el = boxes[i]
      if (!el) return
      const mapped = mapImageBox(box, natural, rect, scroll)
      el.style.left = `${mapped.left}px`
      el.style.top = `${mapped.top}px`
      el.style.width = `${mapped.width}px`
      el.style.height = `${mapped.height}px`
      el.style.fontSize = `${overlayFontSize(mapped.height)}px`
    })
    if (close) {
      close.style.left = `${rect.left + scroll.x + rect.width - 28}px`
      close.style.top = `${rect.top + scroll.y + 4}px`
    }
  }

  const hide = (): void => {
    host?.remove()
    host = null
    root = null
    target = null
    current = null
    boxes = []
    close = null
  }

  const show = (dto: ImageOverlayDto): string => {
    hide()
    const image = findImageBySrc(dto.src)
    if (!image) return 'image not found'
    if (dto.boxes.length === 0) return 'no text'
    target = image
    current = dto
    host = document.createElement('div')
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;'
    root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = OVERLAY_STYLE
    root.appendChild(style)
    for (const box of dto.boxes) {
      const el = document.createElement('div')
      el.className = 'box'
      el.textContent = box.text
      root.appendChild(el)
      boxes.push(el)
    }
    close = document.createElement('button')
    close.type = 'button'
    close.className = 'close'
    close.textContent = '✕'
    close.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      hide()
    })
    root.appendChild(close)
    document.documentElement.appendChild(host)
    place()
    return `overlay: ${dto.boxes.length}`
  }

  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  return { show, hide }
}

// === 설치 =================================================================

/** 배치 한 덩어리의 결과. 실패 사유는 메인이 준 오류 코드 문자열이다(원문은 담기지 않는다) */
export type TranslateReply = { ok: true; texts: string[] } | { ok: false; error: string }

/** 진행률 보고 한 건. 화면에 "번역 중 12/398" 로 보여 줄 값만 담는다 */
export interface TranslateProgress {
  /** 아직 돌고 있는 배치가 있는가 */
  running: boolean
  /** 화면에 반영된 노드 수 */
  done: number
  /** 이번 실행에서 번역 대기열에 올린 노드 수 */
  total: number
  /** 마지막 실패 사유 코드(있을 때만) */
  error?: string
}

export interface PageTranslateDeps {
  /** 원문 배열을 보내고 같은 순서의 번역 배열을 받는다 */
  translate: (texts: string[], lang: string) => Promise<TranslateReply>
  /** 진행률 보고(메인 → 렌더러로 흘러간다). 없으면 보고하지 않는다 */
  progress?: (p: TranslateProgress) => void
}

export interface PageTranslateApi {
  /** 화면 번역 실행(대상 언어). 결과 문구를 돌려준다 */
  run: (lang: string) => Promise<string>
  /** 원문 보기 */
  restore: () => string
  /** 지금 번역 상태인가 */
  active: () => boolean
  /** 이미지 번역 오버레이 표시 */
  showImageOverlay: (dto: ImageOverlayDto) => string
  hideImageOverlay: () => void
}

export function installPageTranslate(deps: PageTranslateDeps): PageTranslateApi {
  const overlay = createImageOverlay()
  // 아직 번역하지 않은 감싸개(화면에 들어오면 번역한다)
  const pending = new Set<HTMLElement>()
  let observer: IntersectionObserver | null = null
  let running = false
  let translatedCount = 0
  // 이번 실행에서 대기열에 올린 노드 수(진행률의 분모)
  let queuedTotal = 0
  // 지금 돌고 있는 묶음 수. 0 이면 더 보낼 것이 없다는 뜻이다
  let inFlight = 0
  let lastError = ''

  // 마지막으로 요청한 대상 언어(스크롤로 새로 보이는 노드도 같은 언어로 번역한다)
  let targetLang = 'ko'

  const report = (): void => {
    deps.progress?.({
      running: inFlight > 0,
      done: translatedCount,
      total: queuedTotal,
      ...(lastError ? { error: lastError } : {})
    })
  }

  const translateElements = async (targets: HTMLElement[]): Promise<void> => {
    if (targets.length === 0) return
    const texts = targets.map((el) => el.getAttribute(ORIG_ATTR) ?? '')
    // 배치를 동시에 여러 개 띄우고, 먼저 끝난 것부터 바로 화면에 꽂는다
    const tasks = splitBatches(texts).map((batch) => async (): Promise<void> => {
      const slice = batch.map((i) => texts[i])
      const reply = await deps.translate(slice, targetLang)
      if (!reply.ok) {
        lastError = reply.error
        report()
        return
      }
      batch.forEach((index, i) => {
        const value = reply.texts[i]
        if (typeof value !== 'string' || !value) return
        targets[index].textContent = value
        translatedCount += 1
      })
      report()
    })
    await runWithLimit(tasks)
  }

  const flush = async (targets: HTMLElement[]): Promise<void> => {
    for (const el of targets) pending.delete(el)
    inFlight += 1
    report()
    try {
      await translateElements(targets)
    } finally {
      inFlight -= 1
      report()
    }
  }

  const observe = (elements: HTMLElement[]): void => {
    if (typeof IntersectionObserver === 'undefined') {
      // 관찰자가 없는 환경(구형·테스트)에서는 한 번에 전부 번역한다
      void flush(elements)
      return
    }
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target as HTMLElement)
          .filter((el) => pending.has(el))
        if (visible.length === 0) return
        for (const el of visible) observer?.unobserve(el)
        // 화면 위쪽부터 번역해야 사용자가 보고 있는 곳이 먼저 바뀐다
        const ordered = sortByViewportOrder(visible, (el) => {
          const r = el.getBoundingClientRect()
          return { top: r.top, left: r.left }
        })
        void flush(ordered)
      })
    }
    for (const el of elements) {
      pending.add(el)
      observer.observe(el)
    }
  }

  const run = async (lang: string): Promise<string> => {
    if (running) return 'busy'
    running = true
    targetLang = lang
    lastError = ''
    try {
      const nodes = collectTextNodes(document.body)
      const wrapped = wrapTextNodes(nodes)
      queuedTotal = translatedCount + wrapped.length
      if (wrapped.length === 0) {
        report()
        return 'nothing to translate'
      }
      report()
      observe(wrapped)
      return `queued: ${wrapped.length}`
    } finally {
      running = false
    }
  }

  const restore = (): string => {
    pending.clear()
    observer?.disconnect()
    observer = null
    overlay.hide()
    const count = restoreOriginals(document.body)
    translatedCount = 0
    queuedTotal = 0
    lastError = ''
    report()
    return `restored: ${count}`
  }

  return {
    run,
    restore,
    active: () => translatedCount > 0 || pending.size > 0,
    showImageOverlay: (dto) => overlay.show(dto),
    hideImageOverlay: () => overlay.hide()
  }
}
