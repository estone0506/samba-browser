// 대화 ↔ SDK 세션 연결. 같은 대화의 다음 지시는 SDK 세션을 `resume` 해서 앞선 지시·도구 결과를 기억한 채로 돈다.
//
// 왜 로컬 파일인가
// - SDK 세션 파일은 이 PC 의 CLI 저장소(~/.claude/projects)에만 있다. 다른 PC 로 동기화된 대화에는
//   그 세션이 없으므로 chats 표(동기화 대상)에 넣지 않고 userData 의 파일 하나로 둔다
// - 세션이 사라졌으면(파일 정리·다른 cwd) 실행기가 새 세션으로 다시 돌고 이 기록을 지운다
//
// 비밀값 방어: 여기에는 세션 id 와 횟수뿐이다. 대화 본문은 담지 않는다

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface ChatSession {
  sessionId: string
  /** 이 세션으로 돌린 실행 횟수. 상한을 넘으면 새 세션 + 요약으로 갈아탄다(컨텍스트 무한 성장 방지) */
  runs: number
}

/** 한 SDK 세션으로 이어 돌리는 최대 실행 횟수. 넘으면 새 세션을 열고 앞부분은 요약으로 넘긴다 */
export const RESUME_MAX_RUNS = 40

export class ChatSessionStore {
  private map: Record<string, ChatSession> = {}

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (
            v &&
            typeof v === 'object' &&
            typeof (v as ChatSession).sessionId === 'string' &&
            typeof (v as ChatSession).runs === 'number'
          )
            this.map[k] = { sessionId: (v as ChatSession).sessionId, runs: (v as ChatSession).runs }
        }
      }
    } catch {
      // 깨진 파일은 없는 것으로 본다(세션 연결은 있으면 좋은 것이지 필수가 아니다)
      this.map = {}
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.map, null, 1))
    } catch (e: unknown) {
      console.error('대화 세션 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }

  get(chatId: number): ChatSession | null {
    return this.map[String(chatId)] ?? null
  }

  /** 실행이 끝난 뒤 세션 id 를 남긴다. 같은 세션이면 횟수를 올리고, 새 세션이면 1부터 센다 */
  note(chatId: number, sessionId: string): ChatSession {
    const prev = this.get(chatId)
    const next: ChatSession =
      prev && prev.sessionId === sessionId
        ? { sessionId, runs: prev.runs + 1 }
        : { sessionId, runs: 1 }
    this.map[String(chatId)] = next
    this.save()
    return next
  }

  clear(chatId: number): void {
    if (!(String(chatId) in this.map)) return
    delete this.map[String(chatId)]
    this.save()
  }
}

/** 요약에 담을 최근 턴 수(사용자·AI 한 쌍이 1턴) */
export const HISTORY_NOTE_TURNS = 6
/** 한 메시지에서 요약에 싣는 최대 글자 수 */
const HISTORY_NOTE_CHARS = 400

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * 세션을 이어받지 못할 때(세션 없음·상한 초과) 지시문 앞에 붙이는 앞부분 요약.
 * 최근 턴의 사용자 지시와 AI 최종 보고만 싣는다 — 진행 로그·도구 결과는 빼서 짧게 유지한다.
 * 메시지가 없으면 빈 문자열
 */
export function buildHistoryNote(messages: readonly HistoryMessage[]): string {
  const kept = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    // 자동 학습 턴은 절차 저장용이라 대화 맥락이 아니다
    .filter((m) => !(m.role === 'user' && m.content.startsWith('[자동 학습]')))
    .slice(-HISTORY_NOTE_TURNS * 2)
  if (kept.length === 0) return ''
  const lines = kept.map((m) => {
    const body = m.content.replace(/\s+/g, ' ').trim()
    const cut = body.length > HISTORY_NOTE_CHARS ? `${body.slice(0, HISTORY_NOTE_CHARS)}…` : body
    return `- ${m.role === 'user' ? '사용자' : 'AI'}: ${cut}`
  })
  return [
    '[이 대화의 앞부분 요약 — 새 세션이라 도구 결과는 기억하지 못한다. 필요하면 화면을 다시 읽어라]',
    ...lines,
    ''
  ].join('\n')
}
