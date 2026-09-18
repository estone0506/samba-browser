// AI 연결 경로 감지. Claude Code 로그인 여부는 자격 파일 존재 + `claude --version` 으로 본다.
// 어떤 반환값에도 키·토큰이 담기지 않는다(마스킹 문자열만 실어 보낸다)

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { AiProviderStatus, ApiKeyVendor } from '../../shared/ai'

export const VERSION_TIMEOUT_MS = 3000

// 서비스 크레딧 카드는 자리만 잡아 둔다. 문구는 렌더러가 i18n 키로 번역한다
export const SERVICE_CREDIT_DETAIL_KEY = 'settings.ai.serviceCreditSoon'

// Claude Code 가 로그인 자격을 두는 자리(둘 중 하나만 있어도 로그인으로 본다)
export const CLAUDE_CREDENTIAL_PATHS = [
  join(homedir(), '.claude', '.credentials.json'),
  join(homedir(), '.claude.json')
]

export interface ProviderProbes {
  fileExists: (path: string) => boolean
  runVersion: () => Promise<boolean>
}

export function defaultProbes(): ProviderProbes {
  return {
    fileExists: existsSync,
    runVersion: () =>
      new Promise((resolve) => {
        const child = execFile('claude', ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err) => {
          resolve(!err)
        })
        child.on('error', () => resolve(false))
      })
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

/** Claude 구독(= Claude Code 로그인) 상태 */
export async function detectClaudeSubscription(
  probes: ProviderProbes,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<AiProviderStatus> {
  const installed = await withTimeout(probes.runVersion(), timeoutMs)
  if (!installed) {
    return { id: 'claude_subscription', state: 'not_installed', maskedKeys: {} }
  }
  const loggedIn = CLAUDE_CREDENTIAL_PATHS.some((p) => probes.fileExists(p))
  return {
    id: 'claude_subscription',
    state: loggedIn ? 'connected' : 'needs_login',
    maskedKeys: {}
  }
}

/**
 * 제공자 카드 3종. `maskedKeys` 는 ApiKeyStore.masked() 결과만 받는다 —
 * 평문 키는 이 함수의 입력도 출력도 아니다
 */
export async function detectProviders(
  probes: ProviderProbes,
  maskedKeys: Partial<Record<ApiKeyVendor, string>>,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<AiProviderStatus[]> {
  const subscription = await detectClaudeSubscription(probes, timeoutMs)
  const hasKey = Object.keys(maskedKeys).length > 0
  return [
    subscription,
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
