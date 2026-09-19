// AI 연결 경로와 작업별 모델에 관한 공용 타입.
// 이 파일에는 실제 API 키가 담기는 타입이 없다 — 렌더러로 나가는 것은 마스킹 문자열뿐이다

export const AI_PROVIDERS = ['claude_subscription', 'api_key', 'service_credit'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

export const API_KEY_VENDORS = ['anthropic', 'openai', 'gemini'] as const
export type ApiKeyVendor = (typeof API_KEY_VENDORS)[number]

// 작업 등급: 빠름 · 표준 · 깊게 · 화면 인식
export const TASK_MODEL_KEYS = ['fast', 'standard', 'deep', 'visual'] as const
export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number]
export type TaskModels = Record<TaskModelKey, string>

// 제공자 카드 상태. 'unset' 은 아직 아무것도 연결하지 않은 상태다
export const AI_PROVIDER_STATES = [
  'connected',
  'not_installed',
  'needs_login',
  'disabled',
  'unset'
] as const
export type AiProviderState = (typeof AI_PROVIDER_STATES)[number]

export interface AiProviderStatus {
  id: AiProviderId
  state: AiProviderState
  // 키는 마스킹 문자열만. 실제 값은 절대 렌더러로 가지 않는다
  maskedKeys: Partial<Record<ApiKeyVendor, string>>
  // 화면 안내 문구의 i18n 키(평문 문장이 아니다)
  detail?: string
}

export function isAiProviderId(v: unknown): v is AiProviderId {
  return typeof v === 'string' && (AI_PROVIDERS as readonly string[]).includes(v)
}

export function isApiKeyVendor(v: unknown): v is ApiKeyVendor {
  return typeof v === 'string' && (API_KEY_VENDORS as readonly string[]).includes(v)
}

export function isTaskModelKey(v: unknown): v is TaskModelKey {
  return typeof v === 'string' && (TASK_MODEL_KEYS as readonly string[]).includes(v)
}

// 모델 ID·별칭을 사람이 읽는 이름으로. 모르는 값은 그대로 보여 준다
const MODEL_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  fable: 'Fable 5.1',
  opus: 'Opus 5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5'
}
export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model
}
