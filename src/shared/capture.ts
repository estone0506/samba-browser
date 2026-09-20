// 사진·영상 캡처(웨일 캡처 메뉴 방식)의 공용 규칙.
// 메인·렌더러·테스트가 함께 쓰는 순수 로직만 둔다(electron 을 import 하지 않는다).
//
// 주의: 웹페이지 preload(page.ts)는 이 파일을 값으로 import 할 수 없다.
//       페이지 쪽에서 쓰는 채널명은 src/preload/page-constants.ts 에 복제되어 있다.

import { z } from 'zod'

// === 캡처 방식 =============================================================
// 이미지 4종 + 비디오 2종. 웨일 캡처 메뉴와 같은 순서다
export const CAPTURE_MODES = [
  'direct', // 이미지 · 직접 지정(정지 이미지를 띄우고 드래그로 사각 영역)
  'region', // 이미지 · 영역 선택(페이지 DOM 요소 단위)
  'fullPage', // 이미지 · 전체 페이지(스크롤하며 이어붙이기)
  'fullScreen', // 이미지 · 전체 화면(주 모니터)
  'videoDirect', // 비디오 · 직접 지정(웹뷰 영역)
  'videoScreen' // 비디오 · 전체 화면
] as const
export type CaptureMode = (typeof CAPTURE_MODES)[number]

export const IMAGE_CAPTURE_MODES: readonly CaptureMode[] = [
  'direct',
  'region',
  'fullPage',
  'fullScreen'
]
export const VIDEO_CAPTURE_MODES: readonly CaptureMode[] = ['videoDirect', 'videoScreen']

export function isCaptureMode(v: unknown): v is CaptureMode {
  return typeof v === 'string' && (CAPTURE_MODES as readonly string[]).includes(v)
}

export function isVideoCaptureMode(mode: CaptureMode): boolean {
  return VIDEO_CAPTURE_MODES.includes(mode)
}

// === 저장 형식 =============================================================
export const CAPTURE_FORMATS = ['png', 'jpg'] as const
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number]

export function isCaptureFormat(v: unknown): v is CaptureFormat {
  return typeof v === 'string' && (CAPTURE_FORMATS as readonly string[]).includes(v)
}

/** 비디오는 항상 webm(vp9), 이미지는 설정 형식을 따른다 */
export function captureExtension(mode: CaptureMode, format: CaptureFormat): string {
  return isVideoCaptureMode(mode) ? 'webm' : format
}

/** 기본 저장 폴더 이름(사용자가 설정에서 바꾸지 않았을 때 Downloads 아래에 만든다) */
export const DEFAULT_CAPTURE_FOLDER_NAME = 'SAMBA 캡처'

/**
 * 좁은 메뉴에 넣을 수 있게 폴더 경로를 줄인다.
 * 길면 앞을 `…` 로 접고 뒤쪽 폴더 이름부터 남긴다(구분자는 원래 것을 쓴다)
 */
export function shortenCapturePath(path: string, maxLength = 34): string {
  const trimmed = path.trim()
  if (trimmed.length <= maxLength) return trimmed
  const separator = trimmed.includes('\\') ? '\\' : '/'
  const parts = trimmed.split(separator).filter((p) => p.length > 0)
  let out = ''
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const next = `${separator}${parts[i]}${out}`
    if (next.length + 1 > maxLength) break
    out = next
  }
  // 마지막 한 조각조차 길면 그 조각의 뒷부분만 남긴다
  if (!out) return `…${trimmed.slice(trimmed.length - maxLength + 1)}`
  return `…${out}`
}

// === 파일명 규칙 ===========================================================
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** 지역 시간 기준 `YYYYMMDD-HHmmss` */
export function captureTimestamp(d: Date): string {
  const date = `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${date}-${time}`
}

/**
 * 파일명. 같은 초에 두 번 저장하면 뒤에 `-2`, `-3` … 을 붙여 덮어쓰지 않는다.
 * seq 는 0(또는 1)이면 접미사가 붙지 않는다
 */
export function captureFileName(d: Date, extension: string, seq = 0): string {
  const suffix = seq > 1 ? `-${seq}` : ''
  return `${captureTimestamp(d)}${suffix}.${extension}`
}

// === 단축키 ================================================================
/** before-input-event 가 주는 값 중 판정에 필요한 부분만 */
export interface CaptureShortcutInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** 'Alt+Shift+1' 같은 표기를 분해한 결과 */
export interface CaptureShortcutParts {
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

export type CaptureShortcuts = Record<CaptureMode, string>

/** 웨일과 같은 기본 단축키 — 이미지 Alt+1~4, 비디오 Alt+5~6 */
export const DEFAULT_CAPTURE_SHORTCUTS: CaptureShortcuts = {
  direct: 'Alt+1',
  region: 'Alt+2',
  fullPage: 'Alt+3',
  fullScreen: 'Alt+4',
  videoDirect: 'Alt+5',
  videoScreen: 'Alt+6'
}

/**
 * 'Alt+1' → 부분 표기. 빈 문자열이나 수식 키만 있는 표기는 null(= 단축키 없음)이다.
 * 대소문자·공백은 무시하고, 마지막 조각을 실제 키로 본다
 */
export function parseCaptureShortcut(text: unknown): CaptureShortcutParts | null {
  if (typeof text !== 'string') return null
  const parts = text
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const out: CaptureShortcutParts = {
    control: false,
    alt: false,
    shift: false,
    meta: false,
    key: ''
  }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') out.control = true
    else if (lower === 'alt' || lower === 'option') out.alt = true
    else if (lower === 'shift') out.shift = true
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta') out.meta = true
    else if (out.key)
      return null // 실제 키가 두 개 이상이면 잘못된 표기
    else out.key = part
  }
  if (!out.key) return null
  // 한 글자 키는 소문자로 맞춰 둔다(비교할 때도 같은 규칙을 쓴다)
  if (out.key.length === 1) out.key = out.key.toLowerCase()
  return out
}

/** 눌린 키가 이 단축키와 같은가 */
export function matchesCaptureShortcut(
  input: CaptureShortcutInput,
  parts: CaptureShortcutParts
): boolean {
  if (input.type !== 'keyDown') return false
  if (input.control !== parts.control) return false
  if (input.alt !== parts.alt) return false
  if (input.shift !== parts.shift) return false
  if (input.meta !== parts.meta) return false
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  return key === parts.key
}

/**
 * 저장된 값(손상됐을 수 있다)을 항상 유효한 단축키 표로 만든다.
 * 빠졌거나 표기가 잘못된 항목만 기본값으로 되돌린다
 */
export function mergeCaptureShortcuts(raw: unknown): CaptureShortcuts {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_CAPTURE_SHORTCUTS }
  for (const mode of CAPTURE_MODES) {
    const value = source[mode]
    if (typeof value !== 'string') continue
    // 빈 문자열은 "단축키 없음" 이라는 뜻이므로 그대로 둔다
    if (value.trim() === '') {
      out[mode] = ''
      continue
    }
    if (parseCaptureShortcut(value)) out[mode] = value.trim()
  }
  return out
}

/** 눌린 키에 해당하는 캡처 방식. 없으면 null */
export function captureShortcutMode(
  input: CaptureShortcutInput,
  shortcuts: CaptureShortcuts
): CaptureMode | null {
  for (const mode of CAPTURE_MODES) {
    const parts = parseCaptureShortcut(shortcuts[mode])
    if (parts && matchesCaptureShortcut(input, parts)) return mode
  }
  return null
}

// === 영역(사각형) ==========================================================
/** 웹뷰/페이지 좌표계의 사각 영역(CSS 픽셀) */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

// 요소 경계 메시지 상한. 비정상적으로 큰 값으로 메인의 캡처를 흔들지 못하게 막는다
export const MAX_CAPTURE_DIMENSION = 20000

// 페이지 preload(격리 월드) → 메인으로 오는 요소 경계 메시지.
// 값은 전부 유한한 숫자여야 하고, 음수 좌표·0 크기·과대 크기는 받지 않는다
export const captureElementRectSchema = z.object({
  x: z.number().finite().min(0).max(MAX_CAPTURE_DIMENSION),
  y: z.number().finite().min(0).max(MAX_CAPTURE_DIMENSION),
  width: z.number().finite().positive().max(MAX_CAPTURE_DIMENSION),
  height: z.number().finite().positive().max(MAX_CAPTURE_DIMENSION)
})

/** 임의의 IPC 입력을 CaptureRect 로 만든다. 규칙에 어긋나면 null */
export function parseCaptureElementRect(raw: unknown): CaptureRect | null {
  const parsed = captureElementRectSchema.safeParse(raw)
  if (!parsed.success) return null
  const r = parsed.data
  // 정수로 맞춰 둔다 — capturePage 의 rect 는 정수 CSS 픽셀만 받는다
  return {
    x: Math.floor(r.x),
    y: Math.floor(r.y),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height))
  }
}

/** 두 점으로 만든 드래그 사각형(음수 폭·높이 없이 정규화) */
export function normalizeDragRect(
  a: { x: number; y: number },
  b: { x: number; y: number }
): CaptureRect {
  const x = Math.round(Math.min(a.x, b.x))
  const y = Math.round(Math.min(a.y, b.y))
  return {
    x,
    y,
    width: Math.max(1, Math.round(Math.abs(b.x - a.x))),
    height: Math.max(1, Math.round(Math.abs(b.y - a.y)))
  }
}

/** 사각형을 바깥 경계 안으로 잘라 넣는다. 겹치는 부분이 없으면 null */
export function clampRect(rect: CaptureRect, bounds: CaptureRect): CaptureRect | null {
  const left = Math.max(rect.x, bounds.x)
  const top = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width)
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// === 녹화 영역(비디오 · 직접 지정) =========================================
/** 녹화 영역 최소 크기(웹뷰 CSS 픽셀). 이보다 작게 끌면 실수로 본다 */
export const MIN_VIDEO_REGION_SIZE = 32

/** 선택 사각형을 화면 좌표로 옮길 때 필요한 값들 */
export interface VideoRegionSource {
  /** 잘린 곳 없는 웹뷰 영역(화면 픽셀). 선택 사각형의 원점이다 */
  viewport: CaptureRect
  /** 화면 안으로 잘라 넣은 녹화 가능 영역(화면 픽셀). null 이면 viewport 를 그대로 쓴다 */
  crop: CaptureRect | null
  /** 화면 픽셀 / CSS 픽셀 비율 */
  scaleFactor: number
}

/**
 * 오버레이에서 고른 사각형(웹뷰 CSS 픽셀)을 녹화용 화면 픽셀 사각형으로 옮긴다.
 * 너무 작은 선택과 화면 밖으로 완전히 벗어난 선택은 null 이다
 */
export function videoRegionCrop(
  selection: CaptureRect,
  source: VideoRegionSource
): CaptureRect | null {
  if (selection.width < MIN_VIDEO_REGION_SIZE || selection.height < MIN_VIDEO_REGION_SIZE) {
    return null
  }
  const scale = source.scaleFactor > 0 ? source.scaleFactor : 1
  const wanted: CaptureRect = {
    x: Math.round(source.viewport.x + selection.x * scale),
    y: Math.round(source.viewport.y + selection.y * scale),
    width: Math.max(1, Math.round(selection.width * scale)),
    height: Math.max(1, Math.round(selection.height * scale))
  }
  // 웹뷰 영역(화면에 보이는 부분) 밖으로 나간 부분은 잘라 낸다
  return clampRect(wanted, source.crop ?? source.viewport)
}

// === 전체 페이지 이어붙이기 ================================================
/** 결과 이미지 최대 높이(CSS 픽셀). 아주 긴 페이지에서 메모리가 터지지 않게 자른다 */
export const MAX_FULL_PAGE_HEIGHT = 20000
/**
 * 결과 이미지 최대 높이(디바이스 픽셀). CSS 상한만 두면 고해상도 화면(배율 2~3배)에서
 * 실제 이미지가 그 배수만큼 커진다 — 캔버스 높이 한계(대부분 32767)에도 걸린다
 */
export const MAX_FULL_PAGE_DEVICE_HEIGHT = 32767
/** 결과 이미지 총 픽셀 상한(RGBA 4바이트 기준 약 256MB) */
export const MAX_FULL_PAGE_DEVICE_PIXELS = 64_000_000

/**
 * 화면 배율을 감안한 CSS 높이 상한(I17).
 * 디바이스 픽셀 기준 높이·총 픽셀 상한을 CSS 픽셀로 되돌려 셋 중 가장 작은 값을 쓴다
 */
export function maxFullPageCssHeight(viewportWidth: number, deviceScale: number): number {
  const scale = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1
  const deviceWidth = Math.max(1, Math.round(viewportWidth * scale))
  const byHeight = Math.floor(MAX_FULL_PAGE_DEVICE_HEIGHT / scale)
  const byPixels = Math.floor(MAX_FULL_PAGE_DEVICE_PIXELS / deviceWidth / scale)
  return Math.max(1, Math.min(MAX_FULL_PAGE_HEIGHT, byHeight, byPixels))
}

export interface FullPageMetrics {
  /** document 전체 높이 */
  totalHeight: number
  /** 한 번에 보이는 높이 */
  viewportHeight: number
  /** 스크롤해도 따라오는 고정 헤더 높이(첫 장 이후 상단에서 잘라낸다) */
  headerHeight: number
  /** 결과 이미지 최대 높이. 기본 MAX_FULL_PAGE_HEIGHT */
  maxHeight?: number
}

export interface FullPageStep {
  index: number
  /** 이 장을 찍기 전에 스크롤할 위치 */
  scrollY: number
  /** 찍은 화면에서 잘라낼 시작 y(고정 헤더 중복을 건너뛰는 값) */
  sourceTop: number
  /** 잘라낼 높이 */
  height: number
  /** 결과 이미지에 붙일 y */
  destTop: number
}

/**
 * 스크롤하며 찍을 장들의 좌표를 미리 계산한다.
 *
 * 첫 장은 스크롤 0 에서 통째로 쓰고, 두 번째 장부터는 `destTop - headerHeight` 로 스크롤해
 * 화면 위쪽 headerHeight 만큼을 버린다 — 고정 헤더가 매 장 반복되는 것을 막는다.
 * 페이지 끝이라 더 스크롤할 수 없으면 스크롤을 최대치로 묶고 잘라낼 위치를 대신 늘린다.
 */
export function fullPageSteps(m: FullPageMetrics): FullPageStep[] {
  const viewportHeight = Math.floor(m.viewportHeight)
  const totalHeight = Math.floor(m.totalHeight)
  const headerHeight = Math.max(0, Math.floor(m.headerHeight))
  const maxHeight = Math.floor(m.maxHeight ?? MAX_FULL_PAGE_HEIGHT)
  if (viewportHeight <= 0 || totalHeight <= 0 || maxHeight <= 0) return []
  const total = Math.min(totalHeight, maxHeight)
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const steps: FullPageStep[] = []
  let destTop = 0
  let index = 0
  while (destTop < total) {
    const scrollY = index === 0 ? 0 : Math.min(Math.max(0, destTop - headerHeight), maxScroll)
    const sourceTop = destTop - scrollY
    const available = viewportHeight - sourceTop
    // 헤더가 화면만큼 크면 더 진행할 수 없다 — 무한 루프 대신 여기서 멈춘다
    if (available <= 0) break
    const height = Math.min(available, total - destTop)
    steps.push({ index, scrollY, sourceTop, height, destTop })
    destTop += height
    index += 1
  }
  return steps
}

/** fullPageSteps 결과가 채우는 최종 이미지 높이 */
export function fullPageHeight(steps: readonly FullPageStep[]): number {
  const last = steps[steps.length - 1]
  return last ? last.destTop + last.height : 0
}

// === 결과 DTO ==============================================================
/** 저장이 끝난 캡처 1건. 미리보기 토스트가 쓰는 값이다 */
export interface CaptureResultDto {
  mode: CaptureMode
  filePath: string
  fileName: string
  /** 이미지일 때만 채워지는 미리보기(data URL). 비디오는 비어 있다 */
  previewDataUrl: string
  width: number
  height: number
}

/** 비디오 캡처에 쓸 desktopCapturer 소스 + 크롭 정보 */
export interface CaptureVideoSourceDto {
  sourceId: string
  /** 화면(또는 창) 픽셀 크기 */
  width: number
  height: number
  /** videoDirect 일 때만: 잘라낼 웹뷰 영역(화면 픽셀) */
  crop: CaptureRect | null
  /** videoDirect 일 때만: 화면 밖으로 잘리기 전 웹뷰 영역(화면 픽셀). 선택 영역의 원점이다 */
  viewport: CaptureRect | null
  /** 화면 픽셀 / CSS 픽셀 비율 */
  scaleFactor: number
}

/**
 * 녹화 시작 결과. token 은 이 녹화 1건을 가리키는 표이고,
 * 이어 쓰기·마무리·취소는 모두 이 표를 함께 보내야 한다 —
 * 앞 녹화가 늦게 보낸 청크가 다음 녹화 파일을 오염시키지 않게 하기 위함이다
 */
export interface CaptureBeginVideoDto {
  token: string
  fileName: string
}

/** 직접 지정용 정지 이미지 + 그 이미지가 덮는 렌더러 좌표 */
export interface CaptureStillDto {
  dataUrl: string
  /** 렌더러 뷰포트 좌표계에서의 웹뷰 영역 */
  rect: CaptureRect
  /** 이미지 픽셀 / CSS 픽셀 비율 */
  scale: number
}
