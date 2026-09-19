// 구독(Claude Code · Codex CLI) 연결/해지. 기기 로컬 상태이며 동기화 대상이 아니다.
//
// 이 모듈이 지키는 약속:
//  - 자격 파일이 있다고 자동으로 연결되지 않는다. 연결은 사용자가 [연결] 을 눌러야 생긴다.
//  - 해지는 앱의 연결 기록만 지운다. PC 의 CLI 로그인 파일(~/.claude, ~/.codex)은 건드리지 않는다.
//  - 계정 문자열(이메일)만 저장한다. 토큰·키는 읽지도 저장하지도 않는다.

import { spawn } from 'node:child_process'
import {
  connectionKeyOf,
  type AiConnectResult,
  type AiConnection,
  type AiConnections,
  type SubscriptionProviderId
} from '../../shared/ai'
import { probeSubscription, SUBSCRIPTION_CLI, type ProviderProbes } from './providers'

/** 연결 기록 한 칸만 갈아 끼운 새 객체(원본은 건드리지 않는다) */
export function withConnection(
  connections: AiConnections,
  provider: SubscriptionProviderId,
  next: AiConnection
): AiConnections {
  return { ...connections, [connectionKeyOf(provider)]: next }
}

/**
 * 연결 시도. CLI 가 없거나 로그인 자격이 없으면 연결하지 않고 이유만 돌려준다
 * (화면은 그 이유로 `claude login` / `codex login` 안내 다이얼로그를 띄운다)
 */
export async function connectSubscription(
  provider: SubscriptionProviderId,
  probes: ProviderProbes,
  now: () => number = Date.now
): Promise<AiConnectResult> {
  const { installed, hasCredential } = await probeSubscription(provider, probes)
  if (!installed) return { ok: false, reason: 'not_installed' }
  if (!hasCredential) return { ok: false, reason: 'needs_login' }
  // 표시용 계정만 읽는다. 못 읽어도 연결 자체는 성립한다
  const account = probes.readAccount(provider) ?? undefined
  return { ok: true, connection: { connected: true, account, connectedAt: now() } }
}

/** 해지 결과. 자격 파일은 그대로 두므로 기록만 비운다 */
export function disconnectedRecord(): AiConnection {
  return { connected: false }
}

/**
 * 첫 실행 1회 승계: 기존 사용자가 이미 구독으로 쓰고 있던 상태
 * (aiProvider === 'claude_subscription' 이고 자격 파일이 있음)면 connected 로 올려 준다.
 * 이미 승계했거나(migrated) 조건이 아니면 null 을 돌려준다 — 호출부는 아무것도 저장하지 않는다
 */
export function migrateAiConnections(input: {
  migrated: boolean
  aiProvider: string
  connections: AiConnections
  hasClaudeCredential: boolean
  account?: string
  now?: () => number
}): { aiConnections: AiConnections; aiConnectionsMigrated: true } | null {
  if (input.migrated) return null
  const inherit =
    input.aiProvider === 'claude_subscription' &&
    input.hasClaudeCredential &&
    !input.connections.claude?.connected
  if (!inherit) {
    // 승계할 것이 없어도 표식은 남겨 다음 실행에서 다시 보지 않는다
    return { aiConnections: input.connections, aiConnectionsMigrated: true }
  }
  const at = (input.now ?? Date.now)()
  return {
    aiConnections: withConnection(input.connections, 'claude_subscription', {
      connected: true,
      account: input.account,
      connectedAt: at
    }),
    aiConnectionsMigrated: true
  }
}

/** 새 터미널 창에서 `claude login` / `codex login` 을 여는 명령(플랫폼별) */
export function loginTerminalCommand(
  provider: SubscriptionProviderId,
  platform: NodeJS.Platform
): { command: string; args: string[] } {
  const login = SUBSCRIPTION_CLI[provider].loginCommand
  if (platform === 'win32') {
    // start 의 첫 인자는 창 제목 자리라 빈 제목("")을 먼저 넘긴다
    return { command: 'cmd', args: ['/c', 'start', '', 'cmd', '/k', login] }
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${login}"`]
    }
  }
  return { command: 'x-terminal-emulator', args: ['-e', login] }
}

/**
 * 새 터미널 창을 열어 로그인 명령을 띄운다. 자격은 그 창에서 사용자가 직접 만든다 —
 * 앱은 아이디·비밀번호를 대신 입력하지 않는다. 창을 못 열어도 실행을 깨뜨리지 않는다
 */
export function openLoginTerminal(
  provider: SubscriptionProviderId,
  platform: NodeJS.Platform = process.platform
): boolean {
  const { command, args } = loginTerminalCommand(provider, platform)
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return true
  } catch (e) {
    console.warn('로그인 터미널 열기 실패', e instanceof Error ? e.message : String(e))
    return false
  }
}
