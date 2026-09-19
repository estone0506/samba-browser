// 메신저 3종으로 한 줄 보내기. 외부 네트워크를 타는 유일한 자리다.
//
// 규칙
// - 주소는 shared/notify 의 형식 검사를 통과한 것만 쓴다(오타난 주소로 요약이 새지 않게)
// - 텔레그램 요청 URL 에는 봇 토큰이 들어간다 — 이 URL 은 절대 로그에 찍지 않는다
// - 실패는 조용히 사유만 돌려준다. 알림이 안 갔다고 에이전트 작업을 깨뜨리지 않는다

import {
  isDiscordWebhook,
  isSlackWebhook,
  isTelegramChatId,
  isTelegramToken,
  type NotifyChannel,
  type NotifySendResult
} from '../../shared/notify'

/** 전송 상한. 메신저가 응답하지 않아도 10초 뒤에는 포기한다 */
export const NOTIFY_TIMEOUT_MS = 10_000

/** net.fetch 만큼의 최소 형태 — 테스트는 가짜 구현을 넣는다 */
export interface NotifyResponse {
  ok: boolean
  status: number
}
export type NotifyFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  }
) => Promise<NotifyResponse>

/** 채널별 설정값. 설정 표에서 이 모양으로 뽑아 넘긴다 */
export interface NotifyConfig {
  slack: { enabled: boolean; webhook: string }
  discord: { enabled: boolean; webhook: string }
  telegram: { enabled: boolean; token: string; chatId: string }
}

/** 이 채널이 지금 보낼 수 있는 상태인가(켜져 있고 값이 형식에 맞는가) */
export function isChannelReady(channel: NotifyChannel, cfg: NotifyConfig): boolean {
  if (channel === 'slack') return cfg.slack.enabled && isSlackWebhook(cfg.slack.webhook)
  if (channel === 'discord') return cfg.discord.enabled && isDiscordWebhook(cfg.discord.webhook)
  return (
    cfg.telegram.enabled &&
    isTelegramToken(cfg.telegram.token) &&
    isTelegramChatId(cfg.telegram.chatId)
  )
}

/**
 * 채널별 요청 한 건(주소·본문). 값이 없거나 형식이 어긋나면 null.
 * 켬/끔 여부는 보지 않는다 — 테스트 보내기는 꺼진 채널에서도 눌러 볼 수 있어야 한다
 */
export function notifyRequest(
  channel: NotifyChannel,
  cfg: NotifyConfig,
  text: string
): { url: string; body: string } | null {
  if (channel === 'slack') {
    const url = cfg.slack.webhook.trim()
    if (!isSlackWebhook(url)) return null
    return { url, body: JSON.stringify({ text }) }
  }
  if (channel === 'discord') {
    const url = cfg.discord.webhook.trim()
    if (!isDiscordWebhook(url)) return null
    return { url, body: JSON.stringify({ content: text }) }
  }
  const token = cfg.telegram.token.trim()
  const chatId = cfg.telegram.chatId.trim()
  if (!isTelegramToken(token) || !isTelegramChatId(chatId)) return null
  // 이 주소에는 봇 토큰이 들어 있다 — 로그·오류 메시지에 싣지 않는다
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  }
}

/** 한 채널로 한 건 보낸다. 성공/실패 모두 예외를 던지지 않는다 */
export async function sendNotify(
  channel: NotifyChannel,
  cfg: NotifyConfig,
  text: string,
  fetchImpl: NotifyFetch,
  timeoutMs: number = NOTIFY_TIMEOUT_MS
): Promise<NotifySendResult> {
  const req = notifyRequest(channel, cfg, text)
  if (!req) return { ok: false, reason: 'notConfigured' }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: req.body,
      signal: abort.signal
    })
    if (res.ok) return { ok: true }
    return { ok: false, reason: `HTTP ${res.status}` }
  } catch (e: unknown) {
    // 오류 본문에 요청 주소가 실릴 수 있다(텔레그램 주소에는 봇 토큰이 들어 있다).
    // 주소로 보이는 조각을 통째로 지운 뒤 짧게 잘라 돌려준다
    const raw = e instanceof Error ? e.message : String(e)
    const message = raw.replace(/https?:\/\/\S+/g, '(url)').slice(0, 120)
    return { ok: false, reason: abort.signal.aborted ? 'timeout' : message }
  } finally {
    clearTimeout(timer)
  }
}
