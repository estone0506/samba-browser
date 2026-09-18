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

export function serializeSnapshot(s: PageSnapshot): string {
  const lines = [
    `URL: ${s.url}`,
    `TITLE: ${s.title}`,
    '',
    'INTERACTIVE ELEMENTS:',
    ...s.elements.slice(0, MAX_ELEMENTS).map(formatElement),
    '',
    'PAGE TEXT:',
    s.text.slice(0, MAX_TEXT_CHARS)
  ]
  return lines.join('\n')
}
