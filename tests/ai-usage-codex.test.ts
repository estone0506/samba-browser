// Codex 구독 사용량 조회 — 응답 해석과, 토큰·계정 id 가 결과·오류 어디에도 새지 않는지
import { describe, it, expect, vi } from 'vitest'
import {
  CODEX_USAGE_URL,
  fetchCodexUsage,
  parseCodexUsage,
  readCodexAuth
} from '../src/main/ai/usage-codex'

const TOKEN = 'eyJ-CODEX-TESTTOKEN'
const ACCOUNT = 'acct-test'

// 실기 응답 모양(2026-09, wham/usage): 주간 창 하나뿐인 요금제(secondary_window null)
const WEEKLY_ONLY = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12.6,
      limit_window_seconds: 604800,
      reset_after_seconds: 600000,
      reset_at: 1790645380
    },
    secondary_window: null
  }
}
// 5시간 + 주간 두 창이 있는 요금제
const TWO_WINDOWS = {
  rate_limit: {
    primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1790000000 },
    secondary_window: { used_percent: 75, limit_window_seconds: 604800, reset_at: 1790645380 }
  }
}

describe('parseCodexUsage', () => {
  it('주간 창 하나만 있으면 weekly_all 한 줄', () => {
    expect(parseCodexUsage(WEEKLY_ONLY)).toEqual([
      { kind: 'weekly_all', percent: 13, resetsAt: new Date(1790645380 * 1000).toISOString() }
    ])
  })

  it('5시간 창은 session, 주간 창은 weekly_all — 세션이 먼저 온다', () => {
    expect(parseCodexUsage(TWO_WINDOWS)?.map((l) => [l.kind, l.percent])).toEqual([
      ['session', 40],
      ['weekly_all', 75]
    ])
  })

  it('비율은 0~100 으로 자르고 reset_at 이 없으면 null', () => {
    const out = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 140, limit_window_seconds: 604800 } }
    })
    expect(out).toEqual([{ kind: 'weekly_all', percent: 100, resetsAt: null }])
  })

  it('rate_limit 이 없으면 빈 목록, 모양이 다르면 null', () => {
    expect(parseCodexUsage({ plan_type: 'free' })).toEqual([])
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'x' } } })).toBeNull()
    expect(parseCodexUsage('nope')).toBeNull()
  })
})

describe('readCodexAuth', () => {
  it('자격 파일에서 토큰·계정 id 만 꺼내고, 없거나 깨졌으면 null', () => {
    expect(
      readCodexAuth(() => JSON.stringify({ tokens: { access_token: TOKEN, account_id: ACCOUNT } }))
    ).toEqual({ token: TOKEN, accountId: ACCOUNT })
    expect(readCodexAuth(() => JSON.stringify({ tokens: { access_token: TOKEN } }))).toEqual({
      token: TOKEN,
      accountId: null
    })
    expect(readCodexAuth(() => JSON.stringify({ OPENAI_API_KEY: 'sk' }))).toBeNull()
    expect(readCodexAuth(() => '{broken')).toBeNull()
    expect(
      readCodexAuth(() => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })
})

describe('fetchCodexUsage', () => {
  it('토큰은 Authorization, 계정 id 는 ChatGPT-Account-Id 헤더로만 보내고 결과에는 싣지 않는다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => WEEKLY_ONLY }))
    const r = await fetchCodexUsage({
      readAuth: () => ({ token: TOKEN, accountId: ACCOUNT }),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1234
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(CODEX_USAGE_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe(ACCOUNT)
    expect(r).toEqual({
      limits: [
        { kind: 'weekly_all', percent: 13, resetsAt: new Date(1790645380 * 1000).toISOString() }
      ],
      fetchedAt: 1234
    })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(JSON.stringify(r)).not.toContain(ACCOUNT)
  })

  it('자격이 없으면 요청하지 않고 null', async () => {
    const fetchMock = vi.fn()
    expect(
      await fetchCodexUsage({ readAuth: () => null, fetch: fetchMock as unknown as typeof fetch })
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 오류·네트워크 오류·형식 오류는 던지지 않고 null', async () => {
    const auth = (): { token: string; accountId: string } => ({ token: TOKEN, accountId: ACCOUNT })
    expect(
      await fetchCodexUsage({
        readAuth: auth,
        fetch: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
      })
    ).toBeNull()
    expect(
      await fetchCodexUsage({
        readAuth: auth,
        fetch: (async () => {
          throw new Error(`boom ${TOKEN}`)
        }) as unknown as typeof fetch
      })
    ).toBeNull()
    expect(
      await fetchCodexUsage({
        readAuth: auth,
        fetch: (async () => ({ ok: true, json: async () => 'weird' })) as unknown as typeof fetch
      })
    ).toBeNull()
  })
})
