import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'

export interface ProviderInput {
  prompt: string
  systemPrompt: string
  model: string
  mcpServers: Options['mcpServers']
  allowedTools: string[]
  abort: AbortController
}

// Claude Agent SDK 호출. Claude Code 로그인 또는 ANTHROPIC_API_KEY 자동 사용
export function runQuery(input: ProviderInput): Query {
  return query({
    prompt: input.prompt,
    options: {
      systemPrompt: input.systemPrompt,
      model: input.model,
      mcpServers: input.mcpServers,
      allowedTools: input.allowedTools,
      // 내장 도구 전체 비활성화. disallowedTools 는 이중 안전장치
      tools: [],
      disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep'],
      // samba 서버 외의 MCP(사용자 설정·계정 커넥터·플러그인)를 불러오지 않음
      strictMcpConfig: true,
      // 사용자/프로젝트 설정(훅·CLAUDE.md)을 상속하지 않음
      settingSources: [],
      permissionMode: 'default',
      maxTurns: 60,
      abortController: input.abort
    }
  })
}

// 인증 오류 문구 판별 → UI 안내 키
export function classifyAuthError(message: string): 'missing' | 'limit' | null {
  const m = message.toLowerCase()
  if (
    m.includes('not logged in') ||
    m.includes('authentication') ||
    m.includes('api key') ||
    m.includes('unauthorized')
  )
    return 'missing'
  if (m.includes('rate limit') || m.includes('usage limit') || m.includes('429')) return 'limit'
  return null
}
