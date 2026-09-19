// 알림 연동(슬랙·디스코드·텔레그램) 공용 상수와 검증.
// 메인·렌더러가 같은 규칙을 쓰도록 여기 한 곳에만 둔다.
// 이 파일은 토큰 값을 저장하지 않는다 — 형식 검사와 마스킹만 한다

/** 연동할 수 있는 메신저 */
export const NOTIFY_CHANNELS = ['slack', 'discord', 'telegram'] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]

/**
 * 알릴 사건.
 * - done: 에이전트 작업 완료
 * - failed: 에이전트 작업 실패
 * - attention: 사람이 봐야 하는 순간(확인 카드·넘김 카드·폰 결제 비밀번호)
 */
export const NOTIFY_EVENTS = ['done', 'failed', 'attention'] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

/** 전송 결과. 실패 사유는 사람이 읽을 짧은 문자열이다(본문·토큰은 담기지 않는다) */
export type NotifySendResult = { ok: true } | { ok: false; reason: string }

// === 입력값 검증 ===========================================================
// 웹훅 주소는 "아무 URL" 이면 안 된다. 사용자가 실수로 다른 주소를 넣으면
// 작업 요약이 엉뚱한 서버로 나가므로 각 서비스의 고정 접두사만 통과시킨다

const SLACK_PREFIX = 'https://hooks.slack.com/'
const DISCORD_PREFIXES = [
  'https://discord.com/api/webhooks/',
  'https://discordapp.com/api/webhooks/'
]

export function isSlackWebhook(v: string): boolean {
  return v.trim().startsWith(SLACK_PREFIX)
}

export function isDiscordWebhook(v: string): boolean {
  const s = v.trim()
  return DISCORD_PREFIXES.some((p) => s.startsWith(p))
}

/** 텔레그램 봇 토큰(`<숫자>:<영숫자>`) 형식인가 */
export function isTelegramToken(v: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(v.trim())
}

/** 대화 id. 숫자(개인·그룹) 또는 `@채널이름` */
export function isTelegramChatId(v: string): boolean {
  const s = v.trim()
  return /^-?\d{1,20}$/.test(s) || /^@[A-Za-z0-9_]{4,}$/.test(s)
}

/** 화면에 그대로 보여 주지 않기 위한 마스킹(앞 8자 + … + 뒤 4자) */
export function maskSecret(v: string): string {
  const s = v.trim()
  if (s.length === 0) return ''
  if (s.length <= 16) return `${s.slice(0, 3)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}
// === 입력값 검증 끝 =========================================================

// === 메시지 마스킹 ==========================================================
// 사용자가 채팅에 "○○ 비밀번호 abcd1234 로 로그인해 줘" 처럼 적었을 수 있다.
// 알림은 외부 서버로 나가므로 요약을 만들기 **전에** 이런 조각을 지운다

// `비밀번호: xxx`, `pw=xxx`, `token xxx` 처럼 키워드 뒤에 붙은 값.
// 구분자(공백 또는 :=)를 반드시 요구해 "암호화폐" 같은 합성어를 건드리지 않고,
// 앞자리 보호로 "pwd" 처럼 키워드가 단어 안에 든 경우도 거른다
const SECRET_KEYWORD_RE =
  /(?<![A-Za-z0-9])(비밀번호|비번|패스워드|암호|인증번호|password|passwd|pw|passcode|secret|token|토큰|api[_-]?key)(?:은|는|이|가)?(?:\s*[:=]\s*|\s+)(\S+)/gi

// 인증번호·카드번호·계좌번호처럼 이어진 긴 숫자열
const LONG_DIGITS_RE = /\d{6,}/g

/**
 * 외부로 나갈 문장에서 비밀값처럼 보이는 조각을 `***` 로 지운다.
 * 놓치는 것보다 과하게 지우는 쪽이 안전하다
 */
export function maskSecrets(text: string): string {
  return text
    .replace(SECRET_KEYWORD_RE, (m: string, kw: string, value: string) =>
      // 뒤따르는 말이 순우리말·한자어면 비밀값이 아니라 설명이다
      // ("결제 비밀번호 키패드" 를 "비밀번호 ***" 로 지워 버리면 뜻이 사라진다).
      // 실제 비밀값에는 영문·숫자·기호가 반드시 섞인다
      /^[가-힣]+$/.test(value) ? m : `${kw} ***`
    )
    .replace(LONG_DIGITS_RE, '***')
}

/** 작업 요약에 쓰는 사용자 지시 앞부분 길이 */
export const PROMPT_LIMIT = 80
/** 결과 한 줄에 쓰는 마지막 응답 앞부분 길이 */
export const TEXT_LIMIT = 200

/**
 * 마스킹 → 줄바꿈·공백 정리 → 길이 자르기.
 * 자르기 전에 마스킹하므로 잘린 자리에서 비밀값이 살아남지 않는다
 */
export function summarize(text: string, limit: number): string {
  const s = maskSecrets(text).replace(/\s+/g, ' ').trim()
  return s.length <= limit ? s : `${s.slice(0, limit)}…`
}
// === 메시지 마스킹 끝 =======================================================
