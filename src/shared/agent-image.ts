// AI 창에 붙여 넣은 이미지(클립보드 스크린샷 등)를 메인으로 넘기는 모양.
//
// 렌더러는 클립보드에서 읽은 그림을 base64 로 바꿔 지시문과 함께 보낸다.
// 메인은 검증만 하고 그대로 모델에 이미지 블록으로 실어 준다(디스크에 저장하지 않는다).

/** 모델이 받는 이미지 형식. 클립보드 스크린샷은 대부분 PNG 다 */
export const AGENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AgentImageType = (typeof AGENT_IMAGE_TYPES)[number]

/** 한 장 상한(원본 바이트). 5MB 를 넘는 스크린샷은 붙이지 않는다 */
export const AGENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** 한 번에 붙일 수 있는 장수 */
export const AGENT_IMAGE_MAX_COUNT = 4

export interface AgentImage {
  mediaType: AgentImageType
  /** base64 본문(data: 접두어 없음) */
  data: string
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function isImageType(v: unknown): v is AgentImageType {
  return typeof v === 'string' && (AGENT_IMAGE_TYPES as readonly string[]).includes(v)
}

/** base64 문자열이 나타내는 원본 바이트 수 */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/**
 * IPC 로 들어온 값을 검증한다. 형식·크기·장수 가운데 하나라도 어긋나면 null —
 * 일부만 골라 살리지 않는다(사용자가 붙인 그림이 소리 없이 빠지면 모델이 엉뚱한 답을 한다)
 */
export function parseAgentImages(raw: unknown): AgentImage[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > AGENT_IMAGE_MAX_COUNT) return null
  const out: AgentImage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { mediaType, data } = item as { mediaType?: unknown; data?: unknown }
    if (!isImageType(mediaType) || typeof data !== 'string' || data === '') return null
    if (!BASE64_RE.test(data) || base64Bytes(data) > AGENT_IMAGE_MAX_BYTES) return null
    out.push({ mediaType, data })
  }
  return out
}

/** 화면 미리보기용 data URL */
export function agentImageDataUrl(image: AgentImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}
