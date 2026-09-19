import { describe, it, expect } from 'vitest'
import {
  CLAUDE_CREDENTIAL_PATHS,
  CODEX_CREDENTIAL_PATHS,
  SERVICE_CREDIT_DETAIL_KEY,
  VERSION_TIMEOUT_MS,
  detectSubscription,
  detectProviders,
  parseClaudeAccount,
  parseCodexAccount,
  testApiKey,
  type ProviderProbes
} from '../src/main/ai/providers'
import type { AiConnections } from '../src/shared/ai'

// 아무것도 연결하지 않은 기본 상태
const NONE: AiConnections = { claude: { connected: false }, codex: { connected: false } }
const CLAUDE_ON: AiConnections = {
  claude: { connected: true, account: 'me@example.com', connectedAt: 1 },
  codex: { connected: false }
}

// 감지에 필요한 세 가지(파일 존재 · --version 실행 · 표시용 계정)만 주입한다
function makeProbes(o: {
  loggedIn?: boolean
  codexLoggedIn?: boolean
  installed?: boolean | 'hang'
  account?: string | null
  onVersion?: () => void
}): ProviderProbes {
  return {
    fileExists: (p: string) =>
      (Boolean(o.loggedIn) && CLAUDE_CREDENTIAL_PATHS.includes(p)) ||
      (Boolean(o.codexLoggedIn) && CODEX_CREDENTIAL_PATHS.includes(p)),
    runVersion: () => {
      o.onVersion?.()
      if (o.installed === 'hang') return new Promise<boolean>(() => {})
      return Promise.resolve(o.installed !== false)
    },
    readAccount: () => o.account ?? null
  }
}

describe('detectSubscription — 자격 파일만으로는 연결이 아니다', () => {
  it('자격 파일이 있어도 연결 기록이 없으면 available(연결 가능)', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: true, installed: true }),
      NONE
    )
    expect(s.state).toBe('available')
    expect(s.connected).toBe(false)
  })

  it('연결 기록이 있으면 connected + 저장해 둔 계정을 보여 준다', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: true, installed: true }),
      CLAUDE_ON
    )
    expect(s.state).toBe('connected')
    expect(s.connected).toBe(true)
    expect(s.account).toBe('me@example.com')
  })

  it('연결 기록이 있어도 자격 파일이 사라졌으면 needs_login 으로 내려간다', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: false, installed: true }),
      CLAUDE_ON
    )
    expect(s.state).toBe('needs_login')
    expect(s.connected).toBe(false)
  })

  it('실행 실패(ENOENT) → not_installed', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: true, installed: false }),
      CLAUDE_ON
    )
    expect(s.state).toBe('not_installed')
  })

  it('실행이 상한 시간을 넘기면 타임아웃으로 not_installed', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: true, installed: 'hang' }),
      CLAUDE_ON,
      10
    )
    expect(s.state).toBe('not_installed')
  })

  it('Codex 는 ~/.codex/auth.json 존재로 자격을 본다', async () => {
    const probes = makeProbes({ codexLoggedIn: true, installed: true, account: 'me@openai.test' })
    const codex = await detectSubscription('codex_subscription', probes, NONE)
    expect(codex.state).toBe('available')
    // 미연결 카드에는 지금 파일에서 읽은 계정을 미리 보여 준다
    expect(codex.account).toBe('me@openai.test')
    const claude = await detectSubscription('claude_subscription', probes, NONE)
    expect(claude.state).toBe('needs_login')
  })

  it('버전 확인 상한은 3초다', () => {
    expect(VERSION_TIMEOUT_MS).toBe(3000)
  })

  it('반환값에 키·토큰 문자열이 전혀 없다', async () => {
    const s = await detectSubscription(
      'claude_subscription',
      makeProbes({ loggedIn: true, installed: true }),
      CLAUDE_ON
    )
    const json = JSON.stringify(s).toLowerCase()
    expect(s.maskedKeys).toEqual({})
    expect(json).not.toContain('sk-')
    expect(json).not.toContain('token')
    expect(json).not.toContain('credential')
  })
})

describe('계정 파싱 — 표시용 이메일만 꺼낸다', () => {
  it('~/.claude.json 의 oauthAccount.emailAddress 를 읽는다', () => {
    const raw = JSON.stringify({
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'x' },
      projects: {}
    })
    expect(parseClaudeAccount(raw)).toBe('me@example.com')
    expect(parseClaudeAccount('{}')).toBeNull()
  })

  it('~/.codex/auth.json 의 id_token(JWT) 에서 email 클레임만 꺼낸다', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'me@openai.test', sub: 'x' })).toString(
      'base64url'
    )
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: `h.${payload}.s`, access_token: 'secret', refresh_token: 'secret' }
    })
    expect(parseCodexAccount(raw)).toBe('me@openai.test')
    // 토큰만 있고 id_token 이 없으면 계정 모름
    expect(parseCodexAccount(JSON.stringify({ tokens: { access_token: 'secret' } }))).toBeNull()
    expect(parseCodexAccount('{}')).toBeNull()
  })
})

describe('detectProviders', () => {
  it('네 장의 카드를 항상 같은 순서로 돌려준다', async () => {
    const list = await detectProviders(makeProbes({ loggedIn: true, installed: true }), {}, NONE)
    expect(list.map((p) => p.id)).toEqual([
      'claude_subscription',
      'codex_subscription',
      'api_key',
      'service_credit'
    ])
  })

  it('저장된 키가 없으면 api_key 는 unset', async () => {
    const [, , apiKey] = await detectProviders(makeProbes({ installed: true }), {}, NONE)
    expect(apiKey.state).toBe('unset')
    expect(apiKey.maskedKeys).toEqual({})
  })

  it('저장된 키가 있으면 connected + 마스킹만 담는다', async () => {
    const [, , apiKey] = await detectProviders(
      makeProbes({ installed: true }),
      { anthropic: 'sk-ant-••••1234' },
      NONE
    )
    expect(apiKey.state).toBe('connected')
    expect(apiKey.maskedKeys).toEqual({ anthropic: 'sk-ant-••••1234' })
  })

  it('service_credit 은 항상 disabled + 안내 i18n 키', async () => {
    const [, , , credit] = await detectProviders(makeProbes({ installed: true }), {}, NONE)
    expect(credit.state).toBe('disabled')
    expect(credit.detail).toBe(SERVICE_CREDIT_DETAIL_KEY)
    expect(credit.maskedKeys).toEqual({})
  })

  it('--version 은 구독 경로마다 한 번씩만 실행한다', async () => {
    let calls = 0
    await detectProviders(makeProbes({ installed: true, onVersion: () => (calls += 1) }), {}, NONE)
    expect(calls).toBe(2)
  })
})

describe('testApiKey', () => {
  it('벤더별 모델 목록을 한 번만 호출하고 ok 만 돌려준다', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ): Promise<{ ok: boolean; status: number }> => {
      seen.push({ url, headers: init?.headers ?? {} })
      return { ok: true, status: 200 }
    }
    const r = await testApiKey('anthropic', 'sk-ant-api03-abcdefgh1234', fetchImpl)
    expect(r).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    // 키는 헤더로만 간다 — URL(쿼리스트링)에 실리지 않는다
    expect(seen[0].url).not.toContain('abcdefgh')
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-api03-abcdefgh1234')
  })

  it('openai · gemini 도 키를 헤더로만 보낸다', async () => {
    const urls: string[] = []
    const headers: Record<string, string>[] = []
    const fetchImpl = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ): Promise<{ ok: boolean; status: number }> => {
      urls.push(url)
      headers.push(init?.headers ?? {})
      return { ok: true, status: 200 }
    }
    await testApiKey('openai', 'sk-proj-zzzzzzzzwxyz', fetchImpl)
    await testApiKey('gemini', 'AIzaSyABCDEFGH9876', fetchImpl)
    expect(urls.every((u) => !u.includes('zzzzzzzz') && !u.includes('ABCDEFGH'))).toBe(true)
    expect(headers[0].Authorization).toBe('Bearer sk-proj-zzzzzzzzwxyz')
    expect(headers[1]['x-goog-api-key']).toBe('AIzaSyABCDEFGH9876')
  })

  it('실패 응답이면 ok:false 이고 본문을 담지 않는다', async () => {
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => ({
      ok: false,
      status: 401
    })
    expect(await testApiKey('anthropic', 'sk-ant-api03-abcdefgh1234', fetchImpl)).toEqual({
      ok: false
    })
  })

  it('네트워크 예외도 ok:false 로 삼킨다', async () => {
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      throw new Error('ENOTFOUND')
    }
    expect(await testApiKey('openai', 'sk-proj-zzzzzzzzwxyz', fetchImpl)).toEqual({ ok: false })
  })

  it('빈 키는 호출조차 하지 않는다', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      calls += 1
      return { ok: true, status: 200 }
    }
    expect(await testApiKey('anthropic', '   ', fetchImpl)).toEqual({ ok: false })
    expect(calls).toBe(0)
  })
})
