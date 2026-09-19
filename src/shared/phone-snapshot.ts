// AI 가 보는 폰 화면. 웹 PageSnapshot 과 같은 번호 체계·같은 줄 모양을 쓴다
// (src/shared/snapshot.ts 의 formatElement 규칙을 그대로 따른다).
// 비밀 입력칸은 번호만 남기고 값은 담지 않는다 — 모델에게도 보이지 않는다

export interface PhoneElement {
  id: number
  text: string
  resourceId?: string
  contentDesc?: string
  className: string
  clickable: boolean
  bounds: { l: number; t: number; r: number; b: number }
  center: { x: number; y: number }
  isSecret: boolean
}

export interface PhoneScreen {
  serial: string
  width: number
  height: number
  app: string
  elements: PhoneElement[]
}

/** 한 화면에서 모델에게 넘기는 요소 수 상한(웹 스냅샷과 같은 취지) */
export const MAX_PHONE_ELEMENTS = 120

function formatElement(e: PhoneElement): string {
  const parts = [`[${e.id}] ${e.className.split('.').pop() ?? 'node'}`]
  if (e.text) parts.push(`"${e.text.slice(0, 80)}"`)
  if (e.contentDesc) parts.push(`desc=${e.contentDesc.slice(0, 60)}`)
  if (e.resourceId) parts.push(`id=${e.resourceId.split('/').pop()}`)
  if (e.clickable) parts.push('(clickable)')
  if (e.isSecret) parts.push('(SECRET)')
  return parts.join(' ')
}

export function serializePhoneScreen(s: PhoneScreen): string {
  return [
    `PHONE: ${s.serial}`,
    `APP: ${s.app}`,
    `SIZE: ${s.width}x${s.height}`,
    '',
    'ELEMENTS:',
    ...s.elements.slice(0, MAX_PHONE_ELEMENTS).map(formatElement)
  ].join('\n')
}

export function findElement(s: PhoneScreen, id: number): PhoneElement | null {
  return s.elements.find((e) => e.id === id) ?? null
}
