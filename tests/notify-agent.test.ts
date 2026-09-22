import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'
import { createAgentNotifier, notifyConfigOf } from '../src/main/notify'
import type { AgentEvent } from '../src/shared/ipc'

const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz012'

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return parseSettings({
    ...DEFAULT_SETTINGS,
    notifySlackEnabled: true,
    notifySlackWebhook: 'https://hooks.slack.com/services/T/B/x',
    ...patch
  })
}

/** 보낸 본문만 모으는 가짜 전송기 */
function harness(patch: Partial<Settings> = {}): {
  sent: string[]
  observe: (e: AgentEvent) => void
  setPrompt: (p: string) => void
  test: (c: 'slack' | 'discord' | 'telegram') => Promise<unknown>
} {
  const sent: string[] = []
  const notifier = createAgentNotifier({
    settings: () => settingsWith(patch),
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body).text as string)
      return { ok: true, status: 200 }
    }
  })
  return { sent, observe: notifier.observe, setPrompt: notifier.setPrompt, test: notifier.test }
}

// 보내기는 비동기라 마이크로태스크 한 바퀴를 돌려 준다
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('에이전트 이벤트 → 알림', () => {
  it('완료되면 지시와 마지막 응답을 함께 보낸다', async () => {
    const h = harness()
    h.setPrompt('쿠팡에서 생수 주문해 줘')
    h.observe({ type: 'status', state: 'running', toolCalls: 0 })
    h.observe({ type: 'text', text: '주문을 끝냈어요' })
    h.observe({ type: 'status', state: 'done', toolCalls: 3 })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('작업 완료')
    expect(h.sent[0]).toContain('쿠팡에서 생수 주문해 줘')
    expect(h.sent[0]).toContain('주문을 끝냈어요')
  })

  it('실패는 사유를 붙여 보낸다', async () => {
    const h = harness()
    h.setPrompt('로그인해 줘')
    h.observe({ type: 'status', state: 'failed', message: 'auth:missing', toolCalls: 1 })
    await flush()
    expect(h.sent[0]).toContain('작업 실패')
    expect(h.sent[0]).toContain('auth:missing')
  })

  it('확인 카드와 넘김 카드는 "확인 필요"로 나간다', async () => {
    const h = harness()
    h.setPrompt('페이코로 결제해 줘')
    h.observe({ type: 'confirm', requestId: 'a', action: '결제 12000원 진행', kind: 'danger' })
    h.observe({
      type: 'handoff',
      requestId: 'b',
      kind: 'captcha',
      matched: '결제 비밀번호 키패드',
      url: 'https://shop.example.com/checkout'
    })
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]).toContain('확인 필요')
    expect(h.sent[1]).toContain('결제 비밀번호 키패드')
    // 어디에 로그인·결제 중인지까지 흘리지 않는다
    expect(h.sent[1]).not.toContain('shop.example.com')
  })

  it('사용자가 직접 멈춘 작업은 알리지 않는다', async () => {
    const h = harness()
    h.observe({ type: 'status', state: 'stopped' })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('사건별 스위치를 끄면 그 사건은 보내지 않는다', async () => {
    const h = harness({ notifyOnDone: false, notifyOnAttention: false })
    h.observe({ type: 'status', state: 'done', toolCalls: 1 })
    h.observe({ type: 'confirm', requestId: 'a', action: '삭제', kind: 'danger' })
    h.observe({ type: 'status', state: 'failed', message: 'x', toolCalls: 1 })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('작업 실패')
  })

  it('켜진 채널이 없으면 아무 데도 보내지 않는다', async () => {
    const h = harness({ notifySlackEnabled: false })
    h.observe({ type: 'status', state: 'done', toolCalls: 1 })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('다음 작업의 알림에 이전 응답이 섞이지 않는다', async () => {
    const h = harness()
    h.setPrompt('첫 작업')
    h.observe({ type: 'text', text: '첫 결과' })
    h.observe({ type: 'status', state: 'done', toolCalls: 1 })
    h.setPrompt('둘째 작업')
    h.observe({ type: 'status', state: 'done', toolCalls: 1 })
    await flush()
    expect(h.sent[1]).not.toContain('첫 결과')
  })

  it('전송이 실패해도 예외가 새어 나오지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const notifier = createAgentNotifier({
      settings: () => settingsWith(),
      fetchImpl: async () => {
        throw new Error('네트워크 끊김')
      }
    })
    expect(() => notifier.observe({ type: 'status', state: 'done', toolCalls: 1 })).not.toThrow()
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('알림 설정 저장', () => {
  it('설정 표에서 채널 설정을 그대로 뽑아 온다', () => {
    const cfg = notifyConfigOf(
      settingsWith({ notifyTelegramEnabled: true, notifyTelegramToken: TOKEN })
    )
    expect(cfg.slack.enabled).toBe(true)
    expect(cfg.telegram.token).toBe(TOKEN)
  })

  it('형식이 어긋난 주소·토큰은 저장 단계에서 비워진다', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      notifySlackWebhook: 'https://evil.example.com/x',
      notifyDiscordWebhook: 'https://discord.com/channels/1',
      notifyTelegramToken: 'not-a-token',
      notifyTelegramChatId: '나'
    })
    expect(s.notifySlackWebhook).toBe('')
    expect(s.notifyDiscordWebhook).toBe('')
    expect(s.notifyTelegramToken).toBe('')
    expect(s.notifyTelegramChatId).toBe('')
  })

  it('기본값은 모두 꺼짐이고 사건 스위치만 켜져 있다', () => {
    expect(DEFAULT_SETTINGS.notifySlackEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.notifyDiscordEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.notifyTelegramEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.notifyOnDone).toBe(true)
    expect(DEFAULT_SETTINGS.notifyOnFailed).toBe(true)
    expect(DEFAULT_SETTINGS.notifyOnAttention).toBe(true)
  })

  it('알림 연동 설정은 전부 계정에 따라온다(사용자 요구: 설정 모두 동기화)', () => {
    const synced = [
      'notifySlackEnabled',
      'notifySlackWebhook',
      'notifyDiscordEnabled',
      'notifyDiscordWebhook',
      'notifyTelegramEnabled',
      'notifyTelegramToken',
      'notifyTelegramChatId',
      'notifyOnDone',
      'notifyOnFailed',
      'notifyOnAttention'
    ]
    for (const key of synced) {
      expect([...SYNCED_SETTING_KEYS]).toContain(key)
    }
  })
})
