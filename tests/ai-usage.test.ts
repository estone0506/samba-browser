// Claude 구독 사용량 조회 — 응답 해석과, 토큰이 결과·오류 어디에도 새지 않는지

import { describe, it, expect, vi } from 'vitest'
import {
  CLAUDE_USAGE_URL,
  fetchClaudeUsage,
  parseClaudeUsage,
  readClaudeAccessToken
} from '../src/main/ai/usage'

const TOKEN = 'sk-ant-oat01-TESTTOKEN'

// 실기 응답 모양(2026-09): 세션·주간 전체·모델별 주간
const RESPONSE = {
  five_hour: { utilization: 17 },
  limits: [
    { kind: 'session', percent: 17, resets_at: '2026-09-21T03:20:00+00:00', scope: null },
    { kind: 'weekly_all', percent: 97.4, resets_at: '2026-09-21T14:00:00+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      percent: 100,
      resets_at: '2026-09-21T13:59:59+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }
    },
    { kind: 'something_new', percent: 5, resets_at: null, scope: null }
  ]
}

describe('parseClaudeUsage', () => {
  it('세션·주간 전체·모델별 주간을 뽑고 모르는 종류는 버린다', () => {
    expect(parseClaudeUsage(RESPONSE)).toEqual([
      { kind: 'session', percent: 17, resetsAt: '2026-09-21T03:20:00+00:00' },
      { kind: 'weekly_all', percent: 97, resetsAt: '2026-09-21T14:00:00+00:00' },
      { kind: 'weekly_scoped', percent: 100, resetsAt: '2026-09-21T13:59:59+00:00', model: 'Fable' }
    ])
  })

  it('비율은 0~100 으로 자른다', () => {
    const r = parseClaudeUsage({ limits: [{ kind: 'session', percent: 140, resets_at: null }] })
    expect(r?.[0].percent).toBe(100)
  })

  it('모양이 다르면 null', () => {
    expect(parseClaudeUsage({})).toBeNull()
    expect(parseClaudeUsage('x')).toBeNull()
    expect(parseClaudeUsage({ limits: [{ kind: 'session' }] })).toBeNull()
  })
})

describe('readClaudeAccessToken', () => {
  it('자격 파일에서 토큰만 꺼내고, 없거나 깨졌으면 null', () => {
    expect(
      readClaudeAccessToken(() => JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }))
    ).toBe(TOKEN)
    expect(readClaudeAccessToken(() => '{}')).toBeNull()
    expect(readClaudeAccessToken(() => 'not json')).toBeNull()
    expect(
      readClaudeAccessToken(() => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })
})

describe('fetchClaudeUsage', () => {
  it('토큰을 Authorization 헤더로만 보내고 결과에는 싣지 않는다', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }))
    const r = await fetchClaudeUsage({
      readToken: () => TOKEN,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 123
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(CLAUDE_USAGE_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(r?.fetchedAt).toBe(123)
    expect(r?.limits).toHaveLength(3)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('자격이 없으면 요청하지 않고 null', async () => {
    const fetchMock = vi.fn()
    expect(
      await fetchClaudeUsage({ readToken: () => null, fetch: fetchMock as unknown as typeof fetch })
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 오류·네트워크 오류·형식 오류는 던지지 않고 null', async () => {
    const http = vi.fn(async () => new Response('no', { status: 401 }))
    expect(
      await fetchClaudeUsage({ readToken: () => TOKEN, fetch: http as unknown as typeof fetch })
    ).toBeNull()
    const net = vi.fn(async () => {
      throw new Error(`network down ${TOKEN}`)
    })
    expect(
      await fetchClaudeUsage({ readToken: () => TOKEN, fetch: net as unknown as typeof fetch })
    ).toBeNull()
    const bad = vi.fn(async () => new Response('{"limits":"x"}', { status: 200 }))
    expect(
      await fetchClaudeUsage({ readToken: () => TOKEN, fetch: bad as unknown as typeof fetch })
    ).toBeNull()
  })
})
