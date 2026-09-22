// AI 연결 경로 감지. 구독(Claude Code · Codex CLI)은 자격 파일 존재 + `--version` 으로 본다.
//
// **중요**: 자격 파일이 있다고 해서 "연결됨" 이 아니다. 사용자가 설정에서 [연결] 을 누른
// 기록(settings.aiConnections)이 있어야 connected 이고, 그 전에는 '연결 가능(available)'
// 으로만 보이며 에이전트는 그 경로를 쓰지 않는다.
//
// 어떤 반환값에도 키·토큰이 담기지 않는다(표시용 계정 문자열과 마스킹 문자열만 실어 보낸다)

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { resolveCliBin } from './cli-bin'
import {
  connectionKeyOf,
  type AiConnections,
  type AiProviderState,
  type AiProviderStatus,
  type ApiKeyVendor,
  type SubscriptionProviderId
} from '../../shared/ai'

export const VERSION_TIMEOUT_MS = 3000

// 서비스 크레딧 카드는 자리만 잡아 둔다. 문구는 렌더러가 i18n 키로 번역한다
export const SERVICE_CREDIT_DETAIL_KEY = 'settings.ai.serviceCreditSoon'

// Claude Code 가 로그인 자격을 두는 자리(둘 중 하나만 있어도 로그인으로 본다)
export const CLAUDE_CREDENTIAL_PATHS = [
  join(homedir(), '.claude', '.credentials.json'),
  join(homedir(), '.claude.json')
]

// OpenAI Codex CLI 의 로그인 자격(`codex login` 이 만든다)
export const CODEX_CREDENTIAL_PATHS = [join(homedir(), '.codex', 'auth.json')]

// Claude 는 계정 정보를 ~/.claude.json 의 oauthAccount 에 둔다(자격 파일에는 이메일이 없다)
export const CLAUDE_ACCOUNT_PATH = join(homedir(), '.claude.json')
export const CODEX_ACCOUNT_PATH = join(homedir(), '.codex', 'auth.json')

/** 구독 경로별 실행 파일 이름 · 자격 파일 자리 · 로그인 명령 */
export const SUBSCRIPTION_CLI: Record<
  SubscriptionProviderId,
  { bin: string; credentialPaths: string[]; loginCommand: string }
> = {
  claude_subscription: {
    bin: 'claude',
    credentialPaths: CLAUDE_CREDENTIAL_PATHS,
    // 예전 'claude login' 은 지금 CLI 에 없는 하위 명령이라 로그인 대신 대화가 시작됐다(실기).
    // 먼저 로그아웃해야 다른 계정으로 바꿀 수 있다 — 이미 로그인돼 있으면 login 이 같은 계정으로 끝난다
    loginCommand: 'claude auth logout & claude auth login'
  },
  codex_subscription: {
    bin: 'codex',
    credentialPaths: CODEX_CREDENTIAL_PATHS,
    loginCommand: 'codex login'
  }
}

export interface ProviderProbes {
  fileExists: (path: string) => boolean
  /** `<bin> --version` 이 성공하는가 */
  runVersion: (provider: SubscriptionProviderId) => Promise<boolean>
  /** 표시용 계정 문자열(이메일 등). 못 읽으면 null — 토큰은 절대 돌려주지 않는다 */
  readAccount: (provider: SubscriptionProviderId) => string | null
}

export function defaultProbes(): ProviderProbes {
  return {
    fileExists: existsSync,
    runVersion: (provider) =>
      new Promise((resolve) => {
        // Windows 의 npm 셔틀(codex.cmd)은 이름만으로는 못 돌리므로 실제 실행 파일로 푼다
        const cli = resolveCliBin(SUBSCRIPTION_CLI[provider].bin)
        const child = execFile(
          cli.command,
          [...cli.prefixArgs, '--version'],
          { timeout: VERSION_TIMEOUT_MS },
          (err) => resolve(!err)
        )
        child.on('error', () => resolve(false))
      }),
    readAccount: (provider) => readAccountFromDisk(provider)
  }
}

/** 자격/계정 파일에서 표시용 계정만 뽑는다. 파일을 못 읽어도 조용히 null */
export function readAccountFromDisk(
  provider: SubscriptionProviderId,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')
): string | null {
  try {
    if (provider === 'claude_subscription') return parseClaudeAccount(readFile(CLAUDE_ACCOUNT_PATH))
    return parseCodexAccount(readFile(CODEX_ACCOUNT_PATH))
  } catch {
    // 파일 없음·권한 없음·깨진 JSON 모두 "계정 모름" 으로 본다(값은 로그에 남기지 않는다)
    return null
  }
}

/** ~/.claude.json 의 oauthAccount 에서 이메일만 꺼낸다(토큰은 이 파일에 없다) */
export function parseClaudeAccount(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const account = (parsed as Record<string, unknown>).oauthAccount
  if (!account || typeof account !== 'object') return null
  const email = (account as Record<string, unknown>).emailAddress
  return typeof email === 'string' && email.trim() ? email.trim() : null
}

/**
 * ~/.codex/auth.json 의 id_token(JWT) 에서 email 클레임만 꺼낸다.
 * 서명은 검증하지 않는다 — 이 값은 화면 표시에만 쓰고 권한 판정에는 쓰지 않는다
 */
export function parseCodexAccount(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const tokens = (parsed as Record<string, unknown>).tokens
  const idToken =
    tokens && typeof tokens === 'object' ? (tokens as Record<string, unknown>).id_token : null
  if (typeof idToken !== 'string') return null
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!json || typeof json !== 'object') return null
    const email = (json as Record<string, unknown>).email
    return typeof email === 'string' && email.trim() ? email.trim() : null
  } catch {
    return null
  }
}

// 응답이 없는 실행(자격 프롬프트 등)에 UI 가 묶이지 않도록 상한 시간을 둔다
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    void p
      .then((v) => {
        clearTimeout(timer)
        resolve(v)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(false)
      })
  })
}

/** CLI 설치 여부 + 자격 파일 존재 여부. 연결 여부(사용자 동의)는 여기서 보지 않는다 */
export async function probeSubscription(
  provider: SubscriptionProviderId,
  probes: ProviderProbes,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<{ installed: boolean; hasCredential: boolean }> {
  const installed = await withTimeout(probes.runVersion(provider), timeoutMs)
  if (!installed) return { installed: false, hasCredential: false }
  const hasCredential = SUBSCRIPTION_CLI[provider].credentialPaths.some((p) => probes.fileExists(p))
  return { installed, hasCredential }
}

/**
 * 구독 카드 상태.
 * 설치 안 됨 → 자격 없음(로그인 필요) → 자격 있고 미연결(연결 가능) → 연결됨 순으로 판정한다
 */
export async function detectSubscription(
  provider: SubscriptionProviderId,
  probes: ProviderProbes,
  connections: AiConnections,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<AiProviderStatus> {
  const { installed, hasCredential } = await probeSubscription(provider, probes, timeoutMs)
  const record = connections[connectionKeyOf(provider)] ?? { connected: false }
  let state: AiProviderState
  if (!installed) state = 'not_installed'
  else if (!hasCredential) state = 'needs_login'
  else state = record.connected ? 'connected' : 'available'
  // 연결된 카드는 저장해 둔 계정을, 아직 미연결이면 지금 파일에서 읽은 계정을 보여 준다
  const account = state === 'connected' ? (record.account ?? undefined) : undefined
  const preview = state === 'available' ? (probes.readAccount(provider) ?? undefined) : undefined
  return {
    id: provider,
    state,
    maskedKeys: {},
    connected: state === 'connected',
    account: account ?? preview
  }
}

/**
 * 제공자 카드 4종. `maskedKeys` 는 ApiKeyStore.masked() 결과만 받는다 —
 * 평문 키는 이 함수의 입력도 출력도 아니다
 */
export async function detectProviders(
  probes: ProviderProbes,
  maskedKeys: Partial<Record<ApiKeyVendor, string>>,
  connections: AiConnections,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<AiProviderStatus[]> {
  const claude = await detectSubscription('claude_subscription', probes, connections, timeoutMs)
  const codex = await detectSubscription('codex_subscription', probes, connections, timeoutMs)
  const hasKey = Object.keys(maskedKeys).length > 0
  return [
    claude,
    codex,
    { id: 'api_key', state: hasKey ? 'connected' : 'unset', maskedKeys: { ...maskedKeys } },
    {
      id: 'service_credit',
      state: 'disabled',
      maskedKeys: {},
      detail: SERVICE_CREDIT_DETAIL_KEY
    }
  ]
}

// 키 확인에 쓰는 최소 fetch 모양(테스트에서 주입). 응답 본문은 읽지도 남기지도 않는다
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>

const KEY_TEST_TIMEOUT_MS = 10_000

// 벤더별 "모델 목록" 엔드포인트. 키는 항상 헤더로만 보낸다(쿼리스트링 금지)
function keyTestRequest(
  vendor: ApiKeyVendor,
  key: string
): { url: string; headers: Record<string, string> } {
  if (vendor === 'openai') {
    return {
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${key}` }
    }
  }
  if (vendor === 'gemini') {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: { 'x-goog-api-key': key }
    }
  }
  return {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }
}

/**
 * 키가 살아 있는지 모델 목록 1회 호출로 확인한다.
 * 돌려주는 것은 `{ok}` 뿐이며 응답 본문·키는 로그에 남기지 않는다
 */
export async function testApiKey(
  vendor: ApiKeyVendor,
  key: string,
  fetchImpl?: FetchLike
): Promise<{ ok: boolean }> {
  const value = key.trim()
  if (!value) return { ok: false }
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!doFetch) return { ok: false }
  const { url, headers } = keyTestRequest(vendor, value)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KEY_TEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal })
    return { ok: res.ok }
  } catch {
    // 실패 사유(본문·헤더)는 키를 담을 수 있으므로 기록하지 않는다
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}
