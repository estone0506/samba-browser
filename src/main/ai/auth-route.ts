// 에이전트가 이번 실행에 쓸 인증 경로를 고른다.
//
// 핵심 규칙: 구독 경로는 **사용자가 연결한 경우에만** 쓴다. 이 PC 에 CLI 로그인 자격이
// 남아 있어도 연결 기록이 없으면 쓰지 않는다(연결한 적 없는 계정을 몰래 쓰지 않는다).
// 평문 키는 이 모듈을 지나가지 않는다 — 키가 있는지(boolean)만 본다

import { connectionKeyOf, type AiConnections, type AiProviderId } from '../../shared/ai'

export type AgentAuthMode = 'claude_subscription' | 'codex_subscription' | 'api_key' | 'none'

export interface AgentAuth {
  mode: AgentAuthMode
  /** 'none' 일 때의 사유. 화면은 auth:missing 안내로 바꿔 보여 준다 */
  reason?: 'not_connected' | 'no_key' | 'unavailable'
}

export function resolveAgentAuth(input: {
  provider: AiProviderId
  connections: AiConnections
  hasApiKey: boolean
}): AgentAuth {
  const { provider, connections, hasApiKey } = input
  if (provider === 'api_key') {
    return hasApiKey ? { mode: 'api_key' } : { mode: 'none', reason: 'no_key' }
  }
  if (provider === 'claude_subscription' || provider === 'codex_subscription') {
    if (connections[connectionKeyOf(provider)]?.connected) return { mode: provider }
    // 해지했거나 아직 연결하지 않았다 — 내 API 키가 있으면 그 경로로 돌아간다
    if (hasApiKey) return { mode: 'api_key' }
    return { mode: 'none', reason: 'not_connected' }
  }
  // 서비스 크레딧은 아직 자리만 잡아 둔 카드다
  return { mode: 'none', reason: 'unavailable' }
}
