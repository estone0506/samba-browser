// 크롬 웹스토어 탭에서 "Chrome에 추가" 버튼을 가로채 SAMBA 에 설치한다.
//
// 왜 필요한가
// 웹스토어의 원래 버튼은 크로미움의 비공개 설치 API 를 부르기 때문에 Electron 에서는
// "이 브라우저에서는 설치할 수 없습니다" 안내만 뜨고 아무 일도 일어나지 않는다.
// 그래서 **캡처 단계**에서 클릭을 먼저 잡아 페이지 쪽 처리기가 아예 돌지 못하게 막고,
// 대신 메인에 확장 id 만 보내 기존 웹스토어 설치 경로(crx 내려받기)를 태운다.
//
// 보안 규칙
// - 격리 월드에서만 동작하고, 메인으로 나가는 값은 확장 id(32자) 하나뿐이다
// - 호스트가 웹스토어일 때만 설치된다(page.ts 가 판정한다). 메인도 발신 탭을 다시 검증한다
// - shared/* 의 값은 import 하지 않는다(sandbox preload 규칙, page-constants 참고)

/** 크롬 웹스토어 호스트 */
export const WEBSTORE_HOST = 'chromewebstore.google.com'

/** 확장 id 는 a–p 32자다(크로미움이 공개키 해시를 그렇게 인코딩한다) */
const EXTENSION_ID_RE = /^[a-p]{32}$/

/** 설치 버튼 문구(정규화된 형태). 웹스토어 언어가 무엇이든 이 중 하나로 떨어진다 */
const ADD_LABELS = new Set(['chrome에추가', '크롬에추가', 'addtochrome'])

/**
 * 버튼 문구 비교용 정규화 — 소문자화 + 공백 제거.
 * 자바스크립트의 `\s` 는 NBSP(U+00A0)도 공백으로 치므로 따로 적지 않아도 된다
 */
function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 웹스토어 호스트인가(www. 접두사와 포트는 무시한다) */
export function isWebstoreHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .split(':')[0]
    .replace(/^www\./, '')
  return h === WEBSTORE_HOST
}

/**
 * 주소의 경로에서 확장 id 를 뽑는다.
 * `/detail/<이름>/<id>` 형태이고, SPA 라 이동할 때마다 다시 읽어야 한다.
 * 상세 페이지가 아니면 null
 */
export function extractWebstoreId(pathname: string): string | null {
  const segments = pathname.split(/[/?#]/).filter(Boolean)
  const hit = [...segments].reverse().find((s) => EXTENSION_ID_RE.test(s))
  return hit ?? null
}

/** 정규화한 문구가 "Chrome에 추가" 계열인가 */
export function isAddButtonLabel(text: string): boolean {
  return ADD_LABELS.has(normalizeLabel(text))
}

/** 눌린 요소가 버튼 역할인가(웹스토어는 button 이지만 a/role 로 바뀔 수 있다) */
function isButtonLike(el: Element): boolean {
  const tag = el.tagName
  if (tag === 'BUTTON' || tag === 'A') return true
  return el.getAttribute('role') === 'button'
}

/** 요소 자신이 내세우는 문구(aria-label 이 있으면 그걸 먼저 본다) */
function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return aria
  return el.textContent ?? ''
}

/**
 * 클릭 대상에서 위로 올라가며 "Chrome에 추가" 버튼을 찾는다.
 * 문구가 정확히 일치하는 조상만 후보로 보므로 페이지 전체가 잡히는 일은 없다.
 * 같은 문구를 가진 조상이 여러 개면 버튼 역할인 쪽을 고른다(문구 교체 대상이 버튼이어야 한다)
 */
export function findAddButton(target: EventTarget | null, maxDepth = 8): HTMLElement | null {
  let node = target instanceof Element ? target : null
  let fallback: HTMLElement | null = null
  for (let depth = 0; node && depth < maxDepth; depth++, node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    if (!isAddButtonLabel(labelOf(node))) continue
    if (isButtonLike(node)) return node
    if (!fallback) fallback = node
  }
  return fallback
}

/**
 * 버튼 안에서 실제로 글자가 놓인 가장 안쪽 요소를 고른다.
 * 여기만 바꾸면 페이지가 입힌 아이콘·배경·클래스는 그대로 남는다
 */
export function labelNodeOf(button: HTMLElement): HTMLElement {
  const leaves = Array.from(button.querySelectorAll<HTMLElement>('*')).filter(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 0
  )
  return leaves.at(-1) ?? button
}

/** 설치 결과(main → page) */
export interface WebstoreInstallResult {
  id: string
  ok: boolean
  error?: string
}

/** 버튼에 덮어쓸 문구 */
export interface WebstoreLabels {
  installing: string
  done: string
  failed: string
}

export interface WebstoreHookDeps {
  /** 확장 id 를 메인으로 보낸다 */
  install: (id: string) => void
  /** 앱 언어에 맞는 문구(언어는 나중에 도착할 수 있어 호출 시점에 읽는다) */
  labels: () => WebstoreLabels
  /** 현재 경로. 기본은 location.pathname (테스트에서 갈아 끼운다) */
  pathname?: () => string
}

export interface WebstoreHook {
  /** 메인이 돌려준 설치 결과를 버튼에 반영한다 */
  finish: (result: WebstoreInstallResult) => void
}

/**
 * 클릭 캡처 리스너를 document 에 **한 번만** 건다.
 * 웹스토어는 SPA 라 주소가 바뀌어도 document 는 그대로이므로, id 는 클릭 시점에 다시 읽는다
 */
export function installWebstoreHook(deps: WebstoreHookDeps): WebstoreHook {
  const pathname = deps.pathname ?? ((): string => location.pathname)
  // 설치를 요청해 둔 버튼들(같은 확장을 두 번 누르는 것을 막고, 결과를 되돌려 적는다)
  const pending = new Map<string, HTMLElement>()

  // 웹스토어는 click 이 아니라 pointerdown/pointerup(jsaction)에서 "Chrome으로 전환할까요?" 안내를
  // 띄운다. 버튼 위의 포인터 이벤트는 캡처 단계에서 모두 끊어 그 안내가 뜨지 않게 한다
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const) {
    document.addEventListener(
      type,
      (event: Event) => {
        if (!event.isTrusted || !findAddButton(event.target)) return
        event.stopPropagation()
        event.stopImmediatePropagation()
      },
      true
    )
  }

  document.addEventListener(
    'click',
    (event: MouseEvent) => {
      // 페이지 스크립트가 만든 합성 클릭은 무시한다(사용자가 누른 것만 설치로 이어진다)
      if (!event.isTrusted) return
      const button = findAddButton(event.target)
      if (!button) return
      const id = extractWebstoreId(pathname())
      if (!id) return
      // 원래 버튼의 처리기(= 설치 불가 안내)가 돌지 못하게 캡처 단계에서 끊는다
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (pending.has(id)) return
      pending.set(id, button)
      labelNodeOf(button).textContent = deps.labels().installing
      deps.install(id)
    },
    true
  )

  return {
    finish: (result: WebstoreInstallResult): void => {
      const button = pending.get(result.id)
      if (!button) return
      pending.delete(result.id)
      const labels = deps.labels()
      labelNodeOf(button).textContent = result.ok ? labels.done : labels.failed
    }
  }
}
