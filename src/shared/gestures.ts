// 마우스 제스처 — 방향 시퀀스와 동작 매핑(메인·렌더러·설정 공용).
//
// 웨일 방식: 오른쪽 버튼을 누른 채 움직이면 이동 방향이 시퀀스로 쌓이고,
// 버튼을 놓는 순간 시퀀스에 매핑된 동작을 실행한다.
//
// [주의] 이 파일은 src/preload/page*.ts 에서 import 하면 안 된다(번들 분리 규칙).
//        페이지 preload 가 쓰는 값은 src/preload/page-constants.ts 에 복제되어 있고,
//        tests/preload-bundle.test.ts 가 두 쪽의 값을 대조한다.

/** 인식하는 방향 4가지. L 왼쪽 · R 오른쪽 · U 위 · D 아래 */
export const GESTURE_DIRECTIONS = ['L', 'R', 'U', 'D'] as const
export type GestureDirection = (typeof GESTURE_DIRECTIONS)[number]

/**
 * 제스처가 실행할 동작.
 * 'none' 은 "아무것도 안 함" — 설정 표에서 특정 제스처만 끄는 데 쓴다.
 */
export const GESTURE_ACTIONS = [
  'none',
  'back',
  'forward',
  'scrollTop',
  'scrollBottom',
  'home',
  'reload',
  'newTab',
  'newWindow',
  'newProfileTab',
  'closeTab',
  'reopenTab',
  'fullscreen',
  'maximize',
  'minimize'
] as const
export type GestureAction = (typeof GESTURE_ACTIONS)[number]

export function isGestureAction(v: unknown): v is GestureAction {
  return typeof v === 'string' && (GESTURE_ACTIONS as readonly string[]).includes(v)
}

/**
 * 설정 화면 표에 나오는 제스처 순서(웨일 기본 16종).
 * 1단계 4종 + 2단계 12종이고, 대각선은 인식하지 않는다.
 */
export const GESTURE_SEQUENCES = [
  'L',
  'R',
  'U',
  'D',
  'LR',
  'RL',
  'UD',
  'DU',
  'DL',
  'DR',
  'LD',
  'RD',
  'UL',
  'LU',
  'UR',
  'RU'
] as const
export type GestureSequence = (typeof GESTURE_SEQUENCES)[number]

/**
 * 웨일 기본 매핑 그대로.
 * 다만 '시크릿창에서 열기'(←↓)는 우리 앱에 시크릿창이 없어 '새 프로필 탭'으로,
 * '새 창 열기'(↓←)는 단일 창 구조라 새 탭 열기로 대체한다(라벨에도 그대로 적어 둔다).
 */
export const DEFAULT_MOUSE_GESTURES: Record<string, GestureAction> = {
  L: 'back', // ← 이전 페이지
  R: 'forward', // → 다음 페이지
  U: 'scrollTop', // ↑ 맨 위로
  D: 'scrollBottom', // ↓ 맨 아래로
  LR: 'home', // ←→ 홈페이지로
  RL: 'home', // →← 홈페이지로
  UD: 'reload', // ↑↓ 새로고침
  DU: 'reload', // ↓↑ 새로고침
  DL: 'newWindow', // ↓← 새 창 열기
  DR: 'newTab', // ↓→ 새 탭 열기
  LD: 'newProfileTab', // ←↓ 시크릿창에서 열기 → 새 프로필 탭
  RD: 'closeTab', // →↓ 탭 닫기
  UL: 'fullscreen', // ↑← 전체화면
  LU: 'reopenTab', // ←↑ 닫은 탭 다시 열기
  UR: 'maximize', // ↑→ 창 최대화
  RU: 'minimize' // →↑ 창 최소화
}

/** 기본값 복원용 사본(호출부가 그대로 저장해도 원본이 오염되지 않게 한다) */
export function defaultMouseGestures(): Record<string, GestureAction> {
  return { ...DEFAULT_MOUSE_GESTURES }
}

/**
 * 시퀀스에 매핑된 동작. 사용자가 지운 키·깨진 값은 기본값으로 되돌리고,
 * 기본값에도 없는 시퀀스(오인식)는 'none' 으로 흘려보낸다
 */
export function resolveGestureAction(
  sequence: string,
  mapping: Record<string, GestureAction | string> = DEFAULT_MOUSE_GESTURES
): GestureAction {
  const picked = mapping[sequence]
  if (isGestureAction(picked)) return picked
  return DEFAULT_MOUSE_GESTURES[sequence] ?? 'none'
}

/** 설정 화면·제스처 궤적 라벨이 쓰는 화살표 표기(←→↑↓) */
export function gestureArrows(sequence: string): string {
  const table: Record<string, string> = { L: '←', R: '→', U: '↑', D: '↓' }
  return sequence
    .split('')
    .map((d) => table[d] ?? '')
    .join('')
}
