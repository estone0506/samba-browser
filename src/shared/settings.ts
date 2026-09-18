import { z } from 'zod'
import { DEFAULT_DANGER_WORDS, mergeDangerWords } from './danger'

// 도구 호출 상한 허용 범위
export const MIN_TOOL_CALLS = 1
export const MAX_TOOL_CALLS = 200

// 오른쪽 패널 폭 허용 범위
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 900

export const DEFAULT_SETTINGS = {
  model: 'sonnet' as const,
  language: 'ko' as const,
  panelWidth: 380,
  lastUrl: 'https://www.google.com',
  dangerWords: DEFAULT_DANGER_WORDS,
  maxToolCalls: 40
}

// 손상된 config.json 이어도 앱이 뜨도록 필드마다 catch 로 기본값으로 되돌린다
export const settingsSchema = z.object({
  model: z.enum(['sonnet', 'opus', 'haiku']).catch(DEFAULT_SETTINGS.model),
  language: z.enum(['ko', 'en']).catch(DEFAULT_SETTINGS.language),
  panelWidth: z
    .number()
    .min(MIN_PANEL_WIDTH)
    .max(MAX_PANEL_WIDTH)
    .catch(DEFAULT_SETTINGS.panelWidth),
  lastUrl: z.string().min(1).catch(DEFAULT_SETTINGS.lastUrl),
  dangerWords: z.array(z.string()).catch([]),
  maxToolCalls: z.number().catch(DEFAULT_SETTINGS.maxToolCalls)
})

export type Settings = z.infer<typeof settingsSchema>

export function clampToolCalls(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxToolCalls
  return Math.min(MAX_TOOL_CALLS, Math.max(MIN_TOOL_CALLS, Math.round(n)))
}

// 임의의 입력(파일 내용·IPC 패치 결과)을 항상 유효한 Settings 로 만든다
export function parseSettings(input: unknown): Settings {
  const r = settingsSchema.safeParse(input)
  const v = r.success ? r.data : { ...DEFAULT_SETTINGS }
  return {
    ...v,
    // 위험 단어는 기본 목록과의 합집합이라 사용자가 비워도 보호가 유지된다
    dangerWords: mergeDangerWords(v.dangerWords),
    maxToolCalls: clampToolCalls(v.maxToolCalls)
  }
}
