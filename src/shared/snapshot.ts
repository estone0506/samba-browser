// AI가 보는 페이지 구조 스냅샷 타입과 직렬화
export interface PageElement {
  id: number
  tag: string
  role: string
  text: string
  name?: string
  href?: string
  inputType?: string
  isSecret: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  text: string
  elements: PageElement[]
  // 페이지에서 보이는 상호작용 요소 전체 개수(나열은 MAX_ELEMENTS 개로 자른다).
  // 잘렸다는 사실을 모델이 알아야 find_elements 로 되찾을 수 있다
  total?: number
}

/**
 * 결제 비밀번호 키패드 판정용 신호.
 * 값(입력 내용)은 절대 담기지 않는다 — "있는지·몇 개인지" 만 센다
 */
export interface KeypadSignals {
  url: string
  // 문구 판정용 페이지 텍스트(앞부분만)
  text: string
  // 0~9 숫자 하나만 보이는 클릭 요소 개수
  digitButtons: number
  // 결제 비밀번호로 보이는 짧은 비밀 입력칸이 있는가
  pinField: boolean
}

export const MAX_TEXT_CHARS = 8000
export const MAX_ELEMENTS = 150

// 요소 한 줄 표현: [id] role "텍스트" name=… href=… (SECRET)
function formatElement(e: PageElement): string {
  const parts = [`[${e.id}] ${e.role}`]
  if (e.text) parts.push(`"${e.text.slice(0, 80)}"`)
  if (e.name) parts.push(`name=${e.name}`)
  if (e.href) parts.push(`href=${e.href.slice(0, 120)}`)
  if (e.isSecret) parts.push('(SECRET)')
  return parts.join(' ')
}

// 나열이 잘렸을 때 모델에게 되찾는 방법을 알려 준다
function truncationNote(s: PageSnapshot): string[] {
  const shown = Math.min(s.elements.length, MAX_ELEMENTS)
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
    'INTERACTIVE ELEMENTS:',
    ...s.elements.slice(0, MAX_ELEMENTS).map(formatElement),
    ...truncationNote(s),
    '',
    'PAGE TEXT:',
    s.text.slice(0, MAX_TEXT_CHARS)
  ]
  return lines.join('\n')
}
