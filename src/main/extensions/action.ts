// 확장 액션(툴바 아이콘) 순수 로직.
//
// Electron 39 는 chrome.action 을 구현하지 않는다 — 확장이 아이콘을 그려 달라고 요청할 수도,
// chrome.action.onClicked 를 받을 수도 없다. 그래서 크롬이 브라우저 쪽에서 해 주던 일
// (아이콘 고르기 · 팝업 문서 띄우기)을 우리가 manifest 를 직접 읽어 대신한다.
//
// 여기에는 electron import 가 없다 — 경로 결정·크기 제한·위치 계산을 그대로 테스트한다.

import type { ExtensionAnchorDto } from '../../shared/extensions'
import { pickIconPath } from './import-sources'

/** 팝업 창 크기 한계. 크롬과 같은 상한(800×600)을 쓴다 */
export const POPUP_MIN_WIDTH = 120
export const POPUP_MIN_HEIGHT = 60
export const POPUP_MAX_WIDTH = 800
export const POPUP_MAX_HEIGHT = 600

/** 문서 크기를 알기 전에 잠깐 쓰는 크기(preferred-size 가 오면 곧바로 덮인다) */
export const POPUP_DEFAULT_WIDTH = 360
export const POPUP_DEFAULT_HEIGHT = 420

/** 툴바 버튼과 팝업 사이 여백(px) */
const POPUP_GAP = 6

/** 크기 두 개를 한 벌로 다룬다 */
export interface PopupSize {
  width: number
  height: number
}

export interface PopupBounds extends PopupSize {
  x: number
  y: number
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * manifest 에서 액션(툴바 버튼) 정의를 꺼낸다.
 * MV3 는 `action`, MV2 는 `browser_action` 이고, 둘 다 없으면 `page_action` 까지 본다 —
 * 크롬도 page_action 을 MV3 에서 action 으로 합쳤으므로 같은 자리로 취급한다
 */
export function pickActionSection(raw: unknown): Record<string, unknown> | null {
  const manifest = record(raw)
  if (!manifest) return null
  return (
    record(manifest.action) ??
    record(manifest.browser_action) ??
    record(manifest.page_action) ??
    null
  )
}

/**
 * 확장 안의 문서 경로를 안전한 상대 경로로 정규화한다.
 *
 * 확장이 준 문자열을 그대로 `chrome-extension://<id>/` 뒤에 붙이므로,
 * 폴더 밖을 가리키거나(`..`) 다른 출처로 튀는(`//`, `scheme:`) 값은 받지 않는다.
 * 쿼리·해시(`popup.html?tab=1`)는 크롬도 그대로 쓰므로 남겨 둔다
 */
export function normalizeDocumentPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // 역슬래시는 윈도우에서만 구분자라 경로 판정이 갈린다 — 미리 슬래시로 맞춘다
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed) return null
  // `http://…`, `//other` 처럼 다른 출처를 가리키는 값은 문서 경로가 아니다
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  if (trimmed.startsWith('//')) return null
  const path = trimmed.replace(/^\/+/, '')
  if (!path) return null
  // 경로 조각에 `..` 이 하나라도 있으면 확장 폴더 밖을 노린 값으로 본다
  const [pathname] = path.split(/[?#]/)
  if (pathname.split('/').some((seg) => seg === '..')) return null
  return path
}

/** 액션의 default_popup(MV3 action / MV2 browser_action) 상대 경로. 없으면 null */
export function resolvePopupPath(raw: unknown): string | null {
  const action = pickActionSection(raw)
  if (!action) return null
  return normalizeDocumentPath(action.default_popup)
}

/**
 * 옵션 페이지 상대 경로. `options_ui.page` 를 먼저 보고 없으면 `options_page` 를 쓴다
 * (크롬과 같은 우선순위다)
 */
export function resolveOptionsPath(raw: unknown): string | null {
  const manifest = record(raw)
  if (!manifest) return null
  const ui = record(manifest.options_ui)
  return normalizeDocumentPath(ui?.page) ?? normalizeDocumentPath(manifest.options_page)
}

/**
 * 툴바에 그릴 아이콘의 상대 경로.
 * action.default_icon 이 우선이고(크기별 표일 수도, 파일 한 개일 수도 있다),
 * 없으면 manifest icons 중 가장 큰 것으로 내려간다
 */
export function resolveActionIconPath(raw: unknown): string | null {
  const manifest = record(raw)
  if (!manifest) return null
  const action = pickActionSection(raw)
  const defaultIcon = action?.default_icon
  if (typeof defaultIcon === 'string') {
    const single = normalizeDocumentPath(defaultIcon)
    if (single) return single
  }
  const fromAction = pickIconPath(defaultIcon)
  if (fromAction) return fromAction
  return pickIconPath(manifest.icons)
}

/** `chrome-extension://<id>/<경로>` 를 만든다 */
export function extensionPopupUrl(id: string, path: string): string {
  return `chrome-extension://${id}/${path.replace(/^\/+/, '')}`
}

/**
 * 문서가 알려 온 선호 크기를 팝업 창 크기로 다듬는다.
 * 숫자가 아니거나 0 이하면 기본값으로 되돌리고, 크롬과 같은 상한(800×600)에서 자른다
 */
export function clampPopupSize(width: unknown, height: unknown): PopupSize {
  const w =
    typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : POPUP_DEFAULT_WIDTH
  const h =
    typeof height === 'number' && Number.isFinite(height) && height > 0
      ? height
      : POPUP_DEFAULT_HEIGHT
  return {
    width: Math.round(Math.min(POPUP_MAX_WIDTH, Math.max(POPUP_MIN_WIDTH, w))),
    height: Math.round(Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, h)))
  }
}

/**
 * 툴바 버튼 아래에 팝업을 붙일 좌표를 낸다.
 *
 * 렌더러가 보고한 좌표는 그때의 뷰포트 기준이므로, 지금 창 콘텐츠 크기에 비례해 다시 투영한다
 * (화면 확대 비율·창 크기 변경 중에도 버튼과 어긋나지 않는다).
 * 크롬처럼 버튼의 오른쪽 끝에 팝업 오른쪽을 맞추고, 창 밖으로 나가면 안쪽으로 밀어 넣는다
 */
export function popupBounds(
  anchor: ExtensionAnchorDto,
  size: PopupSize,
  contentWidth: number,
  contentHeight: number
): PopupBounds {
  const scale = anchor.viewportWidth > 0 ? contentWidth / anchor.viewportWidth : 1
  // 창보다 큰 팝업은 창 안으로 줄인다 — 넘치면 아예 보이지 않는 쪽이 생긴다
  const width = Math.max(1, Math.min(size.width, contentWidth))
  const height = Math.max(1, Math.min(size.height, contentHeight))
  const right = (anchor.x + anchor.width) * scale
  const below = (anchor.y + anchor.height) * scale + POPUP_GAP
  const x = Math.round(Math.min(Math.max(0, right - width), Math.max(0, contentWidth - width)))
  const y = Math.round(Math.min(Math.max(0, below), Math.max(0, contentHeight - height)))
  return { x, y, width: Math.round(width), height: Math.round(height) }
}
