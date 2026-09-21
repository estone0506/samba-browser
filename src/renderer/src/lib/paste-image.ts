// 클립보드 붙여넣기에서 이미지를 골라 AgentImage 로 바꾼다(AI 창 입력줄이 쓴다).

import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_TYPES,
  type AgentImage,
  type AgentImageType
} from '@shared/agent-image'

export type PasteImageError = 'too-large' | 'unsupported'

/** 붙여넣기 이벤트에 든 이미지 파일들. 텍스트만 붙였으면 빈 배열 */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && file.type.startsWith('image/')) out.push(file)
  }
  return out
}

function isSupported(type: string): type is AgentImageType {
  return (AGENT_IMAGE_TYPES as readonly string[]).includes(type)
}

/** 파일 하나를 base64 로 읽는다. 형식·크기가 어긋나면 오류 코드 */
export async function readAgentImage(file: File): Promise<AgentImage | PasteImageError> {
  if (!isSupported(file.type)) return 'unsupported'
  if (file.size > AGENT_IMAGE_MAX_BYTES) return 'too-large'
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  // 큰 배열을 한 번에 펼치면 호출 스택이 넘치므로 조각으로 나눠 문자열을 만든다
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { mediaType: file.type, data: btoa(binary) }
}
