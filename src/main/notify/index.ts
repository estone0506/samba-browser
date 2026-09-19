// 에이전트 이벤트 스트림을 엿보다가 메신저로 알린다.
//
// 러너·결제 코드를 건드리지 않는 이유: 완료·실패(status), 확인 카드(confirm),
// 사람에게 넘김(handoff — 폰 결제 비밀번호 키패드가 여기로 온다)이 모두
// 이미 하나의 AgentEvent 스트림으로 나온다. 그 길목에서 한 번만 보면 된다

import type { AgentEvent } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import { NOTIFY_CHANNELS, type NotifyChannel, type NotifySendResult } from '../../shared/notify'
import { buildNotifyMessage, buildTestMessage, type NotifyLang } from './message'
import { isChannelReady, sendNotify, type NotifyConfig, type NotifyFetch } from './send'

export interface NotifierDeps {
  /** 지금 설정. 매 사건마다 새로 읽는다(설정을 바꾸면 곧바로 반영된다) */
  settings: () => Settings
  fetchImpl: NotifyFetch
  /** 전송 상한(테스트에서 줄여 쓴다) */
  timeoutMs?: number
}

export interface AgentNotifier {
  /** 작업 시작 시점의 사용자 지시를 기억해 둔다(요약 첫 줄에 쓴다) */
  setPrompt: (prompt: string) => void
  /** 에이전트 이벤트 한 건을 살핀다. 어떤 경우에도 예외를 던지지 않는다 */
  observe: (e: AgentEvent) => void
  /** 설정 화면의 [테스트 보내기]. 켬/끔과 무관하게 지금 값으로 한 번 보낸다 */
  test: (channel: NotifyChannel) => Promise<NotifySendResult>
}

/** 설정 표에서 채널 설정만 뽑아 온다 */
export function notifyConfigOf(s: Settings): NotifyConfig {
  return {
    slack: { enabled: s.notifySlackEnabled, webhook: s.notifySlackWebhook },
    discord: { enabled: s.notifyDiscordEnabled, webhook: s.notifyDiscordWebhook },
    telegram: {
      enabled: s.notifyTelegramEnabled,
      token: s.notifyTelegramToken,
      chatId: s.notifyTelegramChatId
    }
  }
}

export function createAgentNotifier(deps: NotifierDeps): AgentNotifier {
  // 이번 작업의 사용자 지시와 마지막 응답 본문
  let prompt = ''
  let lastText = ''

  const lang = (s: Settings): NotifyLang => (s.language === 'en' ? 'en' : 'ko')

  /** 켜져 있고 값이 갖춰진 채널 모두에 뿌린다. 실패는 경고 한 줄로 끝낸다 */
  const broadcast = (text: string): void => {
    const s = deps.settings()
    const cfg = notifyConfigOf(s)
    for (const channel of NOTIFY_CHANNELS) {
      if (!isChannelReady(channel, cfg)) continue
      void sendNotify(channel, cfg, text, deps.fetchImpl, deps.timeoutMs).then((r) => {
        if (!r.ok) console.warn(`알림 전송 실패(${channel}): ${r.reason}`)
      })
    }
  }

  return {
    setPrompt: (v: string): void => {
      prompt = v
      lastText = ''
    },
    observe: (e: AgentEvent): void => {
      try {
        const s = deps.settings()
        if (e.type === 'text') {
          lastText = e.text
          return
        }
        if (e.type === 'confirm') {
          if (s.notifyOnAttention) {
            broadcast(
              buildNotifyMessage({ event: 'attention', prompt, reason: e.action, lang: lang(s) })
            )
          }
          return
        }
        if (e.type === 'handoff') {
          // 캡차·2FA·폰 결제 비밀번호 키패드가 모두 이 이벤트로 온다.
          // url 은 보내지 않는다(어디에 로그인 중인지까지 흘릴 이유가 없다)
          if (s.notifyOnAttention) {
            broadcast(
              buildNotifyMessage({ event: 'attention', prompt, reason: e.matched, lang: lang(s) })
            )
          }
          return
        }
        if (e.type !== 'status') return
        if (e.state === 'running') {
          lastText = ''
          return
        }
        if (e.state === 'done' && s.notifyOnDone) {
          broadcast(buildNotifyMessage({ event: 'done', prompt, text: lastText, lang: lang(s) }))
        } else if (e.state === 'failed' && s.notifyOnFailed) {
          broadcast(
            buildNotifyMessage({
              event: 'failed',
              prompt,
              text: lastText,
              reason: e.message,
              lang: lang(s)
            })
          )
        }
        // 'stopped'(사용자가 직접 멈춤)는 알리지 않는다 — 사용자가 이미 화면 앞에 있다
      } catch (err: unknown) {
        console.warn('알림 처리 실패', err instanceof Error ? err.message : String(err))
      }
    },
    test: (channel: NotifyChannel): Promise<NotifySendResult> => {
      const s = deps.settings()
      return sendNotify(
        channel,
        notifyConfigOf(s),
        buildTestMessage(lang(s)),
        deps.fetchImpl,
        deps.timeoutMs
      )
    }
  }
}
