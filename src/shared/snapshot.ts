// AI가 보는 페이지 구조 스냅샷 타입과 직렬화
export interface PageElement {
  id: number
  tag: string
  role: string
  text: string
  name?: string
  href?: string
  inputType?: string
  // 입력칸·선택칸·체크박스의 현재 값(비밀 입력칸은 절대 담지 않는다). 스크립트가 기록 뒤 되읽기 검증에 쓴다
  value?: string
  isSecret: boolean
  // iframe 안 요소면 프레임 번호와 호스트. 메인 프레임 요소에는 없다.
  // 나열할 때 [frame N: host] 구분 헤더를 붙이는 데 쓴다(id 자체에도 번호가 들어 있다)
  frame?: { index: number; host: string }
}

export interface PageSnapshot {
  url: string
  title: string
  text: string
  elements: PageElement[]
  // 페이지에서 보이는 상호작용 요소 전체 개수(나열은 MAX_ELEMENTS 개로 자른다).
  // 잘렸다는 사실을 모델이 알아야 find_elements 로 되찾을 수 있다
  total?: number
  // selector 인자가 CSS 문법에 맞지 않을 때의 안내. 정상 스냅샷에는 없다
  selectorError?: string
}

/**
 * 페이지를 덮고 있는 레이어 하나(공지 모달·쿠폰 바텀시트·앱 설치 배너·결제 확인창).
 * 뒤에 있는 버튼을 누르려다 실패하지 않도록 AI 에게 존재를 먼저 알린다
 */
export interface PageOverlay {
  /** 레이어 자체의 스냅샷 id. 목록에 잡히지 않는 컨테이너면 0 */
  id: number
  /** 사람이 알아볼 짧은 이름(aria-label → 제목 → 본문 앞부분) */
  label: string
  /** 이 레이어를 닫을 후보 버튼들의 스냅샷 id(민감한 레이어는 언제나 빈 배열) */
  closeIds: number[]
  /** 결제·비밀번호·로그인·인증 화면이면 true — 대신 닫지 않는다 */
  sensitive: boolean
}

/**
 * 결제 비밀번호 키패드 판정용 신호.
 * 값(입력 내용)은 절대 담기지 않는다 — "있는지·몇 개인지" 만 센다
 */
/**
 * 결제 비밀번호 키패드의 숫자 버튼 배치(프레임 하나 분). 값은 담기지 않는다 —
 * 어느 숫자가 어느 요소 id 인지와, 지금까지 눌린 자리수(셀 수 있을 때)만 있다
 */
export interface KeypadLayoutDto {
  /** 0~9 각각 정확히 하나씩, 10개 */
  digits: { digit: string; id: number }[]
  /** 비밀 입력칸에 찍힌 자리수. 셀 수 없으면 null(값은 읽지 않는다 — 길이만) */
  filled: number | null
}

export interface KeypadSignals {
  url: string
  // 문구 판정용 페이지 텍스트(앞부분만)
  text: string
  // 0~9 숫자 하나만 보이는 클릭 요소 개수
  digitButtons: number
  // 결제 비밀번호로 보이는 짧은 비밀 입력칸이 있는가
  pinField: boolean
}

// 스냅샷 머리말 한 줄. id 가 스냅샷마다 밀리지 않는다는 사실을 모델에게 알려 준다 —
// 예전 목록에서 본 번호를 그대로 눌러도 된다는 뜻이다
export const STABLE_ID_NOTE = 'NOTE: ids are stable across snapshots on this page.'

// 주문 목록처럼 긴 표는 8000자에 3행밖에 안 들어간다 — 넉넉히 두되 selector 로 좁히는 걸 권한다
export const MAX_TEXT_CHARS = 16000
export const MAX_ELEMENTS = 150

// 요소 한 줄 표현: [id] role "텍스트" name=… href=… (SECRET)
function formatElement(e: PageElement): string {
  const parts = [`[${e.id}] ${e.role}`]
  if (e.text) parts.push(`"${e.text.slice(0, 80)}"`)
  if (e.name) parts.push(`name=${e.name}`)
  if (e.href) parts.push(`href=${e.href.slice(0, 120)}`)
  if (e.value !== undefined && !e.isSecret) parts.push(`value="${e.value.slice(0, 80)}"`)
  if (e.isSecret) parts.push('(SECRET)')
  return parts.join(' ')
}

/**
 * 실제로 나열할 요소. 메인 프레임은 예전처럼 MAX_ELEMENTS 개까지,
 * iframe 요소는 따로 MAX_ELEMENTS 개까지 나열한다 — 메인 프레임이 상한을 다 써 버려
 * 주소 검색창(iframe)이 목록에서 통째로 빠지는 일이 없어야 한다
 */
export function listedElements(s: PageSnapshot): PageElement[] {
  const framed = s.elements.filter((e) => e.frame !== undefined)
  if (framed.length === 0) return s.elements.slice(0, MAX_ELEMENTS)
  const main = s.elements.filter((e) => e.frame === undefined)
  return main.slice(0, MAX_ELEMENTS).concat(framed.slice(0, MAX_ELEMENTS))
}

// 프레임이 바뀌는 자리에 [frame N: host] 구분 헤더를 끼운다
function elementLines(elements: PageElement[]): string[] {
  const lines: string[] = []
  let current = 0
  for (const e of elements) {
    const index = e.frame?.index ?? 0
    if (index !== current) {
      current = index
      if (index > 0) lines.push(`[frame ${index}: ${e.frame?.host ?? ''}]`)
    }
    lines.push(formatElement(e))
  }
  return lines
}

// 나열이 잘렸을 때 모델에게 되찾는 방법을 알려 준다
function truncationNote(s: PageSnapshot): string[] {
  const shown = listedElements(s).length
  const total = s.total ?? shown
  if (total <= shown) return []
  return [
    `… ${total - shown} more elements not listed. ` +
      'Call find_elements with the text you are looking for to get their ids.'
  ]
}

export function serializeSnapshot(s: PageSnapshot): string {
  const lines = [
    `URL: ${s.url}`,
    `TITLE: ${s.title}`,
    '',
    STABLE_ID_NOTE,
    'INTERACTIVE ELEMENTS:',
    ...elementLines(listedElements(s)),
    ...truncationNote(s),
    '',
    'PAGE TEXT:',
    s.text.slice(0, MAX_TEXT_CHARS)
  ]
  return lines.join('\n')
}
