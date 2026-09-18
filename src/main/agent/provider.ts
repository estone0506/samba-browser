import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'

export interface ProviderInput {
  prompt: string
  systemPrompt: string
  model: string
  mcpServers: Options['mcpServers']
  allowedTools: string[]
  abort: AbortController
}

// 사용자가 설정에 넣어 둔 내 API 키를 읽는 함수. 메인 프로세스가 주입한다.
// **`ApiKeyStore.get`(평문 키)을 호출하는 곳은 이 모듈 하나뿐이다.** 값은 SDK 하위 프로세스의
// 환경변수로만 흘러가고, 로그·IPC·렌더러 어디에도 나가지 않는다
let apiKeyResolver: (() => string | null) | null = null

export function setApiKeyResolver(fn: (() => string | null) | null): void {
  apiKeyResolver = fn
}

// 내 API 키를 쓸 때만 환경을 교체한다(교체 시 process.env 를 통째로 펼쳐 PATH 등을 유지)
function resolveEnv(): Record<string, string | undefined> | undefined {
  let key: string | null = null
  try {
    key = apiKeyResolver?.() ?? null
  } catch {
    // 키 조회 실패는 구독 경로로 조용히 되돌린다(값은 로그에 남기지 않는다)
    key = null
  }
  if (!key) return undefined
  return { ...process.env, ANTHROPIC_API_KEY: key }
}

// Claude Agent SDK 호출. Claude Code 로그인 또는 ANTHROPIC_API_KEY 자동 사용
export function runQuery(input: ProviderInput): Query {
  return query({
    prompt: input.prompt,
    options: {
      env: resolveEnv(),
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

// 인증 없음으로 볼 문구. SDK 의 SDKAssistantMessageError 값과 실제 401 응답 문구를 모두 포함
const MISSING_PATTERNS = [
  // 'login' 단독은 페이지·모델 텍스트("로그인 버튼을 눌렀습니다")와 겹쳐 오분류를 만든다
  'not logged in',
  'please login',
  'please log in',
  'authentication',
  'authentication_error',
  'authentication_failed',
  'oauth',
  'api key',
  'api_key',
  'x-api-key',
  'unauthorized',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
  'credential'
]

// 사용 한도·결제 문구. billing_error 는 인증 문제가 아니라 한도/결제 안내가 맞다
const LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'usage limit', 'quota', '429', 'billing_error']

// 인증 오류 문구 판별 → UI 안내 키
export function classifyAuthError(message: string): 'missing' | 'limit' | null {
  const m = message.toLowerCase()
  if (MISSING_PATTERNS.some((p) => m.includes(p))) return 'missing'
  if (LIMIT_PATTERNS.some((p) => m.includes(p))) return 'limit'
  return null
}

// 재시도해도 회복되지 않는 인증/계정 오류. api_retry 관측 시 즉시 중단한다
const FATAL_API_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found'
])

export function isFatalApiError(error: string): boolean {
  return FATAL_API_ERRORS.has(error)
}
