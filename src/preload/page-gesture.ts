// 마우스 제스처 인식(페이지 preload · 격리 월드).
//
// 웨일 방식: 오른쪽 버튼을 누른 채 움직이면 이동 방향이 시퀀스(L/R/U/D)로 쌓이고,
// 버튼을 놓으면 시퀀스를 메인으로 보낸 뒤 그 한 번의 컨텍스트 메뉴만 억제한다.
//
// [규칙] 이 파일은 page.ts 에 인라인되는 preload 모듈이라 src/shared/* 의 **값**을
//        import 할 수 없다. 동작 이름표는 ./page-constants 의 사본을 쓴다.
//
// 충돌 회피
// - 오른쪽 버튼만 본다 → 텍스트 선택(왼쪽 드래그)·링크 드래그와 겹치지 않는다
// - mousedown/mousemove 에서는 preventDefault 를 하지 않는다(페이지 동작을 뺏지 않음)
// - 제스처가 실제로 인식됐을 때만 contextmenu 를 1회 막는다(그냥 오른쪽 클릭은 그대로)

/** 방향 하나로 인정할 최소 이동 거리(px) */
export const GESTURE_MIN_MOVE = 30
/** 한 제스처에 담을 수 있는 최대 방향 수 */
export const GESTURE_MAX_STEPS = 4
/**
 * 대각선 무시 기준. 주축 이동량이 반대축의 이 배수 이상이어야 방향으로 인정한다.
 * (45도에 가까운 움직임은 방향을 정하지 않고 다음 점을 기다린다)
 */
export const GESTURE_DIAGONAL_RATIO = 2
/** 궤적 캔버스를 띄우기 시작하는 이동 거리(px) */
const TRAIL_SHOW_AFTER = 8

export interface GesturePoint {
  x: number
  y: number
}

/**
 * 포인터 이동 경로 → 방향 시퀀스(예: 'L', 'DR').
 *
 * - 직전 기준점에서 minMove 이상 움직여야 방향 하나로 인정한다
 * - 주축/반대축 비율이 GESTURE_DIAGONAL_RATIO 미만이면 대각선으로 보고 무시한다
 * - 같은 방향이 이어지면 시퀀스에 중복으로 쌓지 않는다
 * - GESTURE_MAX_STEPS 를 넘는 방향은 버린다
 */
export function sequenceFromPoints(
  points: readonly GesturePoint[],
  minMove: number = GESTURE_MIN_MOVE
): string {
  if (points.length < 2) return ''
  const dirs: string[] = []
  let anchor = points[0]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const dx = p.x - anchor.x
    const dy = p.y - anchor.y
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    let dir = ''
    if (ax >= minMove && ax >= ay * GESTURE_DIAGONAL_RATIO) dir = dx > 0 ? 'R' : 'L'
    else if (ay >= minMove && ay >= ax * GESTURE_DIAGONAL_RATIO) dir = dy > 0 ? 'D' : 'U'
    // 아직 임계값에 못 미치거나 대각선이면 기준점을 그대로 두고 다음 점을 본다
    else continue
    anchor = p
    if (dirs[dirs.length - 1] === dir) continue
    if (dirs.length >= GESTURE_MAX_STEPS) continue
    dirs.push(dir)
  }
  return dirs.join('')
}

/** 메인이 밀어 주는 제스처 설정(켜짐 여부 · 언어 · 시퀀스→동작 매핑) */
export interface GestureConfig {
  enabled: boolean
  language: 'ko' | 'en'
  mapping: Record<string, string>
}

export interface GestureRecognizerDeps {
  /** 인식된 시퀀스를 메인으로 보낸다(page:gesture) */
  send: (sequence: string) => void
  /** 현재 설정. 메인이 밀어 준 최신 값을 돌려준다 */
  config: () => GestureConfig
  /** 시퀀스에 해당하는 동작 이름(없으면 빈 문자열) */
  labelOf: (sequence: string) => string
}

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  }
  canvas { position: absolute; inset: 0; }
  .label {
    position: absolute; transform: translate(12px, 12px);
    background: rgba(10,132,255,.94); color: #fff;
    border-radius: 999px; padding: 4px 10px;
    font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    box-shadow: 0 4px 14px rgba(0,0,0,.18); white-space: nowrap;
  }
`

/**
 * 문서에 제스처 인식기를 설치한다.
 * DOM 을 직접 만지므로 테스트는 sequenceFromPoints 쪽 순수 함수로 한다
 */
export function installGestureRecognizer(deps: GestureRecognizerDeps): void {
  let tracking = false
  let points: GesturePoint[] = []
  let suppressMenu = false
  let host: HTMLDivElement | null = null
  let canvas: HTMLCanvasElement | null = null
  let label: HTMLDivElement | null = null

  const ensureOverlay = (): HTMLCanvasElement | null => {
    if (canvas) return canvas
    host = document.createElement('div')
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    const wrap = document.createElement('div')
    wrap.className = 'wrap'
    canvas = document.createElement('canvas')
    label = document.createElement('div')
    label.className = 'label'
    label.style.display = 'none'
    wrap.appendChild(canvas)
    wrap.appendChild(label)
    root.appendChild(style)
    root.appendChild(wrap)
    document.documentElement.appendChild(host)
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr))
    canvas.style.width = `${window.innerWidth}px`
    canvas.style.height = `${window.innerHeight}px`
    canvas.getContext('2d')?.scale(dpr, dpr)
    return canvas
  }

  const clearOverlay = (): void => {
    host?.remove()
    host = null
    canvas = null
    label = null
  }

  const draw = (): void => {
    const el = ensureOverlay()
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    ctx.strokeStyle = '#0a84ff'
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
    if (!label) return
    const text = deps.labelOf(sequenceFromPoints(points))
    const last = points[points.length - 1]
    if (!text) {
      label.style.display = 'none'
      return
    }
    label.textContent = text
    label.style.display = 'block'
    label.style.left = `${last.x}px`
    label.style.top = `${last.y}px`
  }

  const cancel = (): void => {
    tracking = false
    points = []
    clearOverlay()
  }

  const movedEnough = (): boolean => {
    if (points.length < 2) return false
    const a = points[0]
    const b = points[points.length - 1]
    return Math.abs(b.x - a.x) + Math.abs(b.y - a.y) >= TRAIL_SHOW_AFTER
  }

  window.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
      if (!e.isTrusted || e.button !== 2) return
      suppressMenu = false
      if (!deps.config().enabled) return
      tracking = true
      points = [{ x: e.clientX, y: e.clientY }]
    },
    true
  )

  window.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      if (!tracking) return
      points.push({ x: e.clientX, y: e.clientY })
      if (movedEnough()) draw()
    },
    true
  )

  window.addEventListener(
    'mouseup',
    (e: MouseEvent) => {
      if (!tracking || e.button !== 2) return
      points.push({ x: e.clientX, y: e.clientY })
      const sequence = sequenceFromPoints(points)
      cancel()
      // 인식된 제스처가 있을 때만 메뉴를 막는다(단순 오른쪽 클릭은 페이지 메뉴 그대로)
      if (!sequence) return
      suppressMenu = true
      deps.send(sequence)
    },
    true
  )

  // 창 밖으로 나가거나 포커스를 잃으면 궤적을 지우고 조용히 취소한다
  window.addEventListener('blur', cancel, true)
  // 창 밖으로 나간 경우만 취소한다. mouseout 의 relatedTarget===null 은 hover 중인 요소가
  // 사라지거나(메뉴 닫힘) iframe 위로 지나갈 때도 생겨 제스처 도중 취소돼 버리므로 쓰지 않는다.
  // 루트 요소의 mouseleave 는 버블링이 없어 문서 자체를 벗어날 때만 한 번 온다
  document.documentElement.addEventListener('mouseleave', () => {
    if (tracking) cancel()
  })

  // 제스처 중에는 링크 드래그가 시작되지 않게 한다(오른쪽 버튼이라 보통 발생하지 않지만 방어)
  window.addEventListener(
    'dragstart',
    (e: Event) => {
      if (tracking) e.preventDefault()
    },
    true
  )

  window.addEventListener(
    'contextmenu',
    (e: MouseEvent) => {
      if (!suppressMenu) return
      suppressMenu = false
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )
}
