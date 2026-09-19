// 에이전트 사건 → 메신저로 보낼 한 덩이 문장.
// 외부 서버로 나가는 유일한 본문이라, 여기에 들어오는 모든 문자열은
// shared/notify 의 마스킹(summarize)을 반드시 거친다

import { PROMPT_LIMIT, TEXT_LIMIT, summarize, type NotifyEvent } from '../../shared/notify'

export type NotifyLang = 'ko' | 'en'

export interface NotifyMessageInput {
  event: NotifyEvent
  /** 사용자가 처음 내린 지시(앞부분만 쓴다) */
  prompt: string
  /** 마지막 응답 본문(완료·실패일 때) */
  text?: string
  /** 실패 사유 또는 사람 확인이 필요한 행동 */
  reason?: string
  lang: NotifyLang
}

const LABELS = {
  ko: {
    done: '작업 완료',
    failed: '작업 실패',
    attention: '확인 필요',
    prompt: '작업',
    result: '결과',
    reason: '이유',
    need: '확인',
    test: '연결 테스트 — 앞으로 작업 결과를 이 대화로 보내 드려요'
  },
  en: {
    done: 'Task done',
    failed: 'Task failed',
    attention: 'Needs you',
    prompt: 'Task',
    result: 'Result',
    reason: 'Reason',
    need: 'Action',
    test: 'Test message — task results will arrive in this chat'
  }
} as const

/** 모든 알림 앞에 붙는 꼬리표. 다른 봇 메시지와 섞여도 알아볼 수 있게 한다 */
export const NOTIFY_PREFIX = '[SAMBA]'

/** 테스트 보내기 버튼이 쓰는 문장 */
export function buildTestMessage(lang: NotifyLang): string {
  return `${NOTIFY_PREFIX} ${LABELS[lang].test}`
}

/**
 * 사건 하나를 사람이 폰에서 한눈에 읽을 문장으로 만든다.
 * 비밀번호·인증번호처럼 보이는 조각은 자르기 전에 지워진다
 */
export function buildNotifyMessage(input: NotifyMessageInput): string {
  const l = LABELS[input.lang]
  const lines = [`${NOTIFY_PREFIX} ${l[input.event]}`]
  const prompt = summarize(input.prompt, PROMPT_LIMIT)
  if (prompt) lines.push(`${l.prompt}: ${prompt}`)
  if (input.event === 'attention') {
    const need = summarize(input.reason ?? '', TEXT_LIMIT)
    if (need) lines.push(`${l.need}: ${need}`)
    return lines.join('\n')
  }
  const text = summarize(input.text ?? '', TEXT_LIMIT)
  if (text) lines.push(`${l.result}: ${text}`)
  if (input.event === 'failed') {
    const reason = summarize(input.reason ?? '', TEXT_LIMIT)
    if (reason) lines.push(`${l.reason}: ${reason}`)
  }
  return lines.join('\n')
}
