import { describe, it, expect } from 'vitest'
import {
  connectSubscription,
  disconnectedRecord,
  loginTerminalCommand,
  migrateAiConnections,
  withConnection
} from '../src/main/ai/connections'
import { resolveAgentAuth } from '../src/main/ai/auth-route'
import type { ProviderProbes } from '../src/main/ai/providers'
import { CLAUDE_CREDENTIAL_PATHS } from '../src/main/ai/providers'
import type { AiConnections } from '../src/shared/ai'

const NONE: AiConnections = { claude: { connected: false }, codex: { connected: false } }

function probes(o: {
  installed?: boolean
  loggedIn?: boolean
  account?: string | null
}): ProviderProbes {
  return {
    fileExists: () => Boolean(o.loggedIn),
    runVersion: () => Promise.resolve(o.installed !== false),
    readAccount: () => o.account ?? null
  }
}

describe('연결 / 해지 상태 전이', () => {
  it('자격이 있으면 연결되고 계정·시각이 남는다', async () => {
    const r = await connectSubscription(
      'claude_subscription',
      probes({ installed: true, loggedIn: true, account: 'me@example.com' }),
      () => 1234
    )
    expect(r).toEqual({
      ok: true,
      connection: { connected: true, account: 'me@example.com', connectedAt: 1234 }
    })
  })

  it('CLI 는 있는데 자격이 없으면 연결하지 않고 needs_login 을 돌려준다', async () => {
    const r = await connectSubscription(
      'codex_subscription',
      probes({ installed: true, loggedIn: false })
    )
    expect(r).toEqual({ ok: false, reason: 'needs_login' })
  })

  it('CLI 가 없으면 not_installed', async () => {
    const r = await connectSubscription(
      'codex_subscription',
      probes({ installed: false, loggedIn: true })
    )
    expect(r).toEqual({ ok: false, reason: 'not_installed' })
  })

  it('해지는 연결 기록만 비운다(다른 카드는 그대로)', () => {
    const connected = withConnection(NONE, 'claude_subscription', {
      connected: true,
      account: 'me@example.com',
      connectedAt: 1
    })
    const codexOn = withConnection(connected, 'codex_subscription', { connected: true })
    const off = withConnection(codexOn, 'claude_subscription', disconnectedRecord())
    expect(off.claude).toEqual({ connected: false })
    expect(off.codex.connected).toBe(true)
    // 원본은 그대로다
    expect(connected.claude.connected).toBe(true)
  })

  it('로그인 안내는 플랫폼별 새 터미널 명령을 돌려준다', () => {
    expect(loginTerminalCommand('claude_subscription', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'cmd', '/k', 'claude login']
    })
    expect(loginTerminalCommand('codex_subscription', 'win32').args).toContain('codex login')
    expect(loginTerminalCommand('codex_subscription', 'linux')).toEqual({
      command: 'x-terminal-emulator',
      args: ['-e', 'codex login']
    })
  })
})

describe('승계 마이그레이션 — 딱 한 번', () => {
  it('구독을 쓰고 있던 기존 사용자는 connected 로 승계된다', () => {
    const patch = migrateAiConnections({
      migrated: false,
      aiProvider: 'claude_subscription',
      connections: NONE,
      hasClaudeCredential: true,
      account: 'me@example.com',
      now: () => 99
    })
    expect(patch?.aiConnections.claude).toEqual({
      connected: true,
      account: 'me@example.com',
      connectedAt: 99
    })
    expect(patch?.aiConnectionsMigrated).toBe(true)
  })

  it('이미 승계했으면 두 번째부터는 아무것도 하지 않는다', () => {
    const first = migrateAiConnections({
      migrated: false,
      aiProvider: 'claude_subscription',
      connections: NONE,
      hasClaudeCredential: true
    })
    expect(first).not.toBeNull()
    const second = migrateAiConnections({
      migrated: true,
      aiProvider: 'claude_subscription',
      connections: first!.aiConnections,
      hasClaudeCredential: true
    })
    expect(second).toBeNull()
  })

  it('자격 파일만 있고 구독 경로가 아니었으면 승계하지 않는다(표식만 남긴다)', () => {
    const patch = migrateAiConnections({
      migrated: false,
      aiProvider: 'api_key',
      connections: NONE,
      hasClaudeCredential: true
    })
    expect(patch?.aiConnections.claude.connected).toBe(false)
    expect(patch?.aiConnectionsMigrated).toBe(true)
  })

  it('자격 파일이 없으면 승계하지 않는다', () => {
    const patch = migrateAiConnections({
      migrated: false,
      aiProvider: 'claude_subscription',
      connections: NONE,
      hasClaudeCredential: false
    })
    expect(patch?.aiConnections.claude.connected).toBe(false)
  })
})

describe('resolveAgentAuth — 미연결 구독은 쓰지 않는다', () => {
  it('연결했으면 그 구독 경로를 쓴다', () => {
    const connections = withConnection(NONE, 'claude_subscription', { connected: true })
    expect(
      resolveAgentAuth({ provider: 'claude_subscription', connections, hasApiKey: false })
    ).toEqual({ mode: 'claude_subscription' })
  })

  it('미연결 구독 + 키 없음 → none(연결 필요)', () => {
    expect(
      resolveAgentAuth({ provider: 'claude_subscription', connections: NONE, hasApiKey: false })
    ).toEqual({ mode: 'none', reason: 'not_connected' })
  })

  it('미연결 구독이라도 내 API 키가 있으면 그 경로로 돌아간다', () => {
    expect(
      resolveAgentAuth({ provider: 'claude_subscription', connections: NONE, hasApiKey: true })
    ).toEqual({ mode: 'api_key' })
  })

  it('Codex 도 연결했을 때만 쓴다', () => {
    const on = withConnection(NONE, 'codex_subscription', { connected: true })
    expect(
      resolveAgentAuth({ provider: 'codex_subscription', connections: on, hasApiKey: false })
    ).toEqual({ mode: 'codex_subscription' })
    expect(
      resolveAgentAuth({ provider: 'codex_subscription', connections: NONE, hasApiKey: false })
    ).toEqual({ mode: 'none', reason: 'not_connected' })
  })

  it('내 API 키 경로인데 키가 없으면 none', () => {
    expect(resolveAgentAuth({ provider: 'api_key', connections: NONE, hasApiKey: false })).toEqual({
      mode: 'none',
      reason: 'no_key'
    })
  })

  it('서비스 크레딧은 아직 쓸 수 없다', () => {
    expect(
      resolveAgentAuth({ provider: 'service_credit', connections: NONE, hasApiKey: true })
    ).toEqual({ mode: 'none', reason: 'unavailable' })
  })
})

describe('자격 파일이 있어도 미연결이면 provider 가 키를 넘기지 않는다', () => {
  it('runQuery 는 SDK 를 부르지 않고 auth:not_connected 로 멈춘다', async () => {
    const { runQuery, setAuthResolver, setApiKeyResolver, NOT_CONNECTED_ERROR } =
      await import('../src/main/agent/provider')
    let keyRead = 0
    setApiKeyResolver(() => {
      keyRead += 1
      return 'sk-ant-should-not-be-used'
    })
    // 이 PC 에 자격 파일이 있어도(fileExists 가 true 여도) 연결 기록이 없으면 none 이다
    setAuthResolver(() =>
      resolveAgentAuth({
        provider: 'claude_subscription',
        connections: NONE,
        hasApiKey: false
      })
    )
    expect(() =>
      runQuery({
        prompt: 'x',
        systemPrompt: 's',
        model: 'sonnet',
        mcpServers: {},
        allowedTools: [],
        abort: new AbortController()
      })
    ).toThrowError(NOT_CONNECTED_ERROR)
    expect(keyRead).toBe(0)
    setAuthResolver(null)
    setApiKeyResolver(null)
  })

  it('Claude 자격 파일 자리는 홈 디렉터리 밑 두 곳뿐이다', () => {
    expect(CLAUDE_CREDENTIAL_PATHS).toHaveLength(2)
  })
})
