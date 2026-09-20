// 페이지를 덮는 레이어(공지 모달·쿠폰 바텀시트·앱 설치 유도 배너) 판정 규칙.
//
// 여기에는 **DOM 을 만지지 않는 순수 함수**만 둔다 — 실제 측정(getComputedStyle·
// getBoundingClientRect)은 page-core 가 하고, "이건 오버레이다/닫기 버튼이다/건드리면
// 안 되는 화면이다" 판정만 이 파일이 맡는다. 덕분에 jsdom 없이도 규칙을 시험할 수 있다.
//
// [규칙] 이 파일은 page.ts 번들에 인라인된다. src/shared/* 에서 값을 import 하지 말 것

/** 오버레이 판정에 필요한 요소 신호(측정은 호출부가 한다) */
export interface OverlaySignals {
  /** role 속성(없으면 빈 문자열) */
  role: string
  /** aria-modal="true" 인가 */
  ariaModal: boolean
  /** getComputedStyle 의 position */
  position: string
  /** z-index. auto 등 숫자가 아니면 0 */
  zIndex: number
  /** 뷰포트 면적 대비 덮는 비율(0~1) */
  coverage: number
}

/** 이 비율 이상 덮어야 "화면을 가린다"고 본다 */
export const OVERLAY_COVERAGE_MIN = 0.3

/** 고정 레이어로 보려면 z-index 가 이 값 이상이어야 한다 */
export const OVERLAY_Z_MIN = 10

/**
 * 화면을 덮는 레이어인가.
 * - role=dialog|alertdialog 이거나 aria-modal 이면 크기와 무관하게 레이어다
 * - 그 밖에는 position 이 fixed/sticky 이고, 뷰포트의 30% 이상을 덮으며, z-index 가 커야 한다
 */
export function isOverlay(s: OverlaySignals): boolean {
  const role = s.role.trim().toLowerCase()
  if (role === 'dialog' || role === 'alertdialog') return true
  if (s.ariaModal) return true
  if (s.position !== 'fixed' && s.position !== 'sticky') return false
  return s.coverage >= OVERLAY_COVERAGE_MIN && s.zIndex >= OVERLAY_Z_MIN
}

// 라벨 하나로 딱 떨어지는 닫기 버튼들
const CLOSE_EXACT_RE = /^(닫기|close|확인|나중에|x|×|✕|✖)$/i
// 문장형 닫기 버튼("오늘 하루 보지 않기" 등)은 부분일치로 본다
const CLOSE_PHRASE_RE =
  /오늘\s?하루\s?보지\s?않기|다시\s?보지\s?않기|그만\s?보기|나중에\s?하기|닫기|close/i
// 라벨이 길면 본문이지 버튼이 아니다
const CLOSE_LABEL_MAX = 24

/** 이 라벨(텍스트 또는 aria-label)이 레이어 닫기 버튼인가 */
export function isCloseLabel(label: string): boolean {
  const s = label.replace(/\s+/g, ' ').trim()
  if (s.length === 0 || s.length > CLOSE_LABEL_MAX) return false
  if (CLOSE_EXACT_RE.test(s)) return true
  return CLOSE_PHRASE_RE.test(s)
}

// 결제 비밀번호·결제 확인·로그인 모달. 절대 대신 닫지 않는다 — 사용자의 몫이다
const SENSITIVE_RE = /결제|비밀번호|\bPIN\b|로그인|인증/i

/** 대신 닫으면 안 되는 레이어인가(결제·비밀번호·로그인·인증) */
export function isSensitiveOverlay(text: string): boolean {
  return SENSITIVE_RE.test(text)
}
