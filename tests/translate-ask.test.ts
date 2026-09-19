// 번역 1회 호출(createSdkAsk) 의 백엔드 분기 — Codex 구독이면 warm pool 을 거치지 않고
// Codex 경로(agent/provider.ts 의 askText → provider-codex.ts 의 runCodex)로 곧장 간다.
// 실제 codex CLI 는 부르지 않는다(provider-codex 의 runCodex 를 가짜로 바꿔치기한다)

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { CodexEvent, CodexInput } from '../src/main/agent/provider-codex'

let codexCalls: CodexInput[] = []
let codexEvents: CodexEvent[] = [
  { type: 'text', text: 'codex 번역 결과' },
  { type: 'done', ok: true }
]

vi.mock('../src/main/agent/provider-codex', async () => {
  const actual = await vi.importActual<typeof import('../src/main/agent/provider-codex')>(
    '../src/main/agent/provider-codex'
  )
  return {
    ...actual,
    runCodex: async function* (input: CodexInput) {
      codexCalls.push(input)
      for (const event of codexEvents) yield event
    }
  }
})

const { setAuthResolver } = await import('../src/main/agent/provider')
const { createSdkAsk } = await import('../src/main/translate/ask')

afterEach(() => {
  setAuthResolver(null)
  codexCalls = []
  codexEvents = [
    { type: 'text', text: 'codex 번역 결과' },
    { type: 'done', ok: true }
  ]
})

describe('createSdkAsk — provider 가 codex_subscription 이면 Codex 경로를 탄다', () => {
  it('runCodex 를 호출하고 그 텍스트를 그대로 돌려준다', async () => {
    setAuthResolver(() => ({ mode: 'codex_subscription' }))
    const { ask, dispose } = createSdkAsk(() => 'gpt-5.6')
    const reply = await ask({ model: 'gpt-5.6', system: '시스템', prompt: '원문' })
    expect(reply).toBe('codex 번역 결과')
    expect(codexCalls).toHaveLength(1)
    expect(codexCalls[0]?.model).toBe('gpt-5.6')
    expect(codexCalls[0]?.systemPrompt).toBe('시스템')
    dispose()
  })

  it('Codex 쪽에서 실패로 끝나도 예외를 던지지 않고 null 을 돌려준다', async () => {
    setAuthResolver(() => ({ mode: 'codex_subscription' }))
    codexEvents = [{ type: 'done', ok: false, message: '한도 초과' }]
    const { ask, dispose } = createSdkAsk(() => 'gpt-5.6')
    const reply = await ask({ model: 'gpt-5.6', system: '시스템', prompt: '원문' })
    expect(reply).toBeNull()
    dispose()
  })

  it('연결이 없으면(auth:none) Codex 를 부르지 않고 null 을 돌려준다', async () => {
    setAuthResolver(() => ({ mode: 'none', reason: 'not_connected' }))
    const { ask, dispose } = createSdkAsk(() => 'gpt-5.6')
    const reply = await ask({ model: 'gpt-5.6', system: '시스템', prompt: '원문' })
    expect(reply).toBeNull()
    expect(codexCalls).toHaveLength(0)
    dispose()
  })
})
