import { describe, it, expect, vi } from 'vitest'
import {
  isDiscordWebhook,
  isSlackWebhook,
  isTelegramChatId,
  isTelegramToken,
  maskSecret
} from '../src/shared/notify'
import {
  isChannelReady,
  notifyRequest,
  sendNotify,
  type NotifyConfig,
  type NotifyFetch
} from '../src/main/notify/send'

const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz012'

function cfg(patch: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    slack: { enabled: true, webhook: 'https://hooks.slack.com/services/T/B/x' },
    discord: { enabled: true, webhook: 'https://discord.com/api/webhooks/1/abc' },
    telegram: { enabled: true, token: TOKEN, chatId: '12345' },
    ...patch
  }
}

describe('웹훅 주소·토큰 형식 검사', () => {
  it('슬랙은 hooks.slack.com 만 통과한다', () => {
    expect(isSlackWebhook('https://hooks.slack.com/services/T/B/x')).toBe(true)
    expect(isSlackWebhook('https://evil.example.com/hooks.slack.com/')).toBe(false)
    expect(isSlackWebhook('http://hooks.slack.com/services/x')).toBe(false)
  })

  it('디스코드는 두 도메인의 webhooks 경로만 통과한다', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/1/abc')).toBe(true)
    expect(isDiscordWebhook('https://discordapp.com/api/webhooks/1/abc')).toBe(true)
    expect(isDiscordWebhook('https://discord.com/channels/1')).toBe(false)
  })

  it('텔레그램 봇 토큰·대화 id 형식', () => {
    expect(isTelegramToken(TOKEN)).toBe(true)
    expect(isTelegramToken('abc:def')).toBe(false)
    expect(isTelegramChatId('-1001234567890')).toBe(true)
    expect(isTelegramChatId('@sambaNotify')).toBe(true)
    expect(isTelegramChatId('나')).toBe(false)
  })

  it('마스킹은 값 전체를 드러내지 않는다', () => {
    const masked = maskSecret(TOKEN)
    expect(masked).not.toBe(TOKEN)
    expect(masked).toContain('…')
    expect(maskSecret('')).toBe('')
  })
})

describe('채널별 요청 만들기', () => {
  it('슬랙은 text, 디스코드는 content 로 보낸다', () => {
    expect(JSON.parse(notifyRequest('slack', cfg(), '안녕')!.body)).toEqual({ text: '안녕' })
    expect(JSON.parse(notifyRequest('discord', cfg(), '안녕')!.body)).toEqual({ content: '안녕' })
  })

  it('텔레그램은 sendMessage 주소에 토큰을 담는다', () => {
    const req = notifyRequest('telegram', cfg(), '안녕')!
    expect(req.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(JSON.parse(req.body).chat_id).toBe('12345')
  })

  it('형식이 어긋난 값이면 요청을 만들지 않는다', () => {
    expect(
      notifyRequest('slack', cfg({ slack: { enabled: true, webhook: 'https://x/' } }), 'x')
    ).toBe(null)
    expect(
      notifyRequest('telegram', cfg({ telegram: { enabled: true, token: TOKEN, chatId: '' } }), 'x')
    ).toBe(null)
  })

  it('켬/끔과 값 형식을 함께 본다', () => {
    expect(isChannelReady('slack', cfg())).toBe(true)
    expect(
      isChannelReady(
        'slack',
        cfg({ slack: { enabled: false, webhook: 'https://hooks.slack.com/x' } })
      )
    ).toBe(false)
    expect(isChannelReady('discord', cfg({ discord: { enabled: true, webhook: '' } }))).toBe(false)
  })
})

describe('전송', () => {
  it('2xx 면 성공', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }))
    await expect(sendNotify('slack', cfg(), '안녕', fetchImpl)).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST')
  })

  it('오류 응답은 상태 코드를 사유로 돌려준다', async () => {
    const fetchImpl: NotifyFetch = async () => ({ ok: false, status: 404 })
    await expect(sendNotify('slack', cfg(), '안녕', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'HTTP 404'
    })
  })

  it('설정이 비어 있으면 네트워크를 타지 않는다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }))
    const empty = cfg({ slack: { enabled: true, webhook: '' } })
    await expect(sendNotify('slack', empty, '안녕', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'notConfigured'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('상한 시간을 넘기면 끊고 timeout 을 돌려준다', async () => {
    const fetchImpl: NotifyFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expect(sendNotify('slack', cfg(), '안녕', fetchImpl, 5)).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
  })

  it('오류 사유에 요청 주소(=텔레그램 토큰)를 싣지 않는다', async () => {
    const fetchImpl: NotifyFetch = async (url) => {
      throw new Error(`request to ${url} failed`)
    }
    const r = await sendNotify('telegram', cfg(), '안녕', fetchImpl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).not.toContain(TOKEN)
  })
})
