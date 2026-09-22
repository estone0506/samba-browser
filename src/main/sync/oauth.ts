// 구글 OAuth 콜백 수신. 커스텀 스킴 딥링크(samba://auth) 대신 127.0.0.1 루프백
// HTTP 서버로 받는다 — OS 프로토콜 등록·단일 인스턴스 처리가 필요 없고,
// 다른 앱이 스킴을 가로채는 위험도 없다.
// 포트는 미리 정해 둔 3개 중 비어 있는 것을 쓴다(Supabase Redirect URLs 에 3개 모두 등록).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { getMainLanguage, tr } from '../i18n'
import { syncMessages } from '../i18n/messages/sync'

/** 콜백을 받을 후보 포트. 앞에서부터 비어 있는 것을 쓴다 */
export const OAUTH_PORTS = [47612, 47613, 47614] as const

export const OAUTH_CALLBACK_PATH = '/callback'
export const OAUTH_HOST = '127.0.0.1'
/** 사용자가 브라우저에서 구글 로그인을 마칠 때까지 기다리는 한도 */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface AuthCallback {
  code?: string
  error?: string
  /** 우리가 redirectTo 에 심어 둔 무작위 값(위조 검증용) */
  state?: string
}

/** Supabase Redirect URLs 에 등록해야 하는 주소를 만든다 */
export function redirectUriFor(port: number, state?: string): string {
  const base = `http://${OAUTH_HOST}:${port}${OAUTH_CALLBACK_PATH}`
  return state ? `${base}?state=${encodeURIComponent(state)}` : base
}

/** 문서·설정 안내에 쓰는 등록 주소 3개 */
export const OAUTH_REDIRECT_URIS: string[] = OAUTH_PORTS.map((p) => redirectUriFor(p))

/** 위조 방지용 state — 무작위 32바이트 */
export function createOAuthState(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 루프백 콜백 주소면 결과를, 아니면 null 을 돌려준다.
 * 호스트·스킴·포트·경로를 모두 검사해 다른 출처의 요청을 걸러 낸다
 */
export function parseAuthCallback(raw: string): AuthCallback | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  // localhost 는 DNS 로 다른 주소에 붙을 수 있으므로 숫자 주소만 인정한다
  if (url.hostname !== OAUTH_HOST) return null
  if (!OAUTH_PORTS.some((p) => String(p) === url.port)) return null
  if (url.pathname !== OAUTH_CALLBACK_PATH) return null

  const state = url.searchParams.get('state') ?? undefined
  const error = url.searchParams.get('error')
  if (error) return state ? { error, state } : { error }
  const code = url.searchParams.get('code')
  if (code) return state ? { code, state } : { code }
  // 암묵적 흐름(#access_token=…)은 PKCE 를 쓰는 우리 설정에서는 오지 않는다
  return state ? { error: 'no-code', state } : { error: 'no-code' }
}

/**
 * 콜백을 받은 브라우저 탭에 보여 줄 안내 문서.
 * 앱 언어를 위에, 다른 언어를 아래에 병기한다(브라우저 언어가 앱과 다를 수 있다)
 */
export function callbackHtml(ok: boolean): string {
  const lang = getMainLanguage()
  const other = syncMessages[lang === 'ko' ? 'en' : 'ko']
  const title = tr(ok ? 'auth.callbackTitleOk' : 'auth.callbackTitleFail')
  const body = tr(ok ? 'auth.callbackBodyOk' : 'auth.callbackBodyFail')
  const titleOther = other[ok ? 'auth.callbackTitleOk' : 'auth.callbackTitleFail']
  const bodyOther = other[ok ? 'auth.callbackBodyOk' : 'auth.callbackBodyFail']
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>SAMBA Browser — ${title}</title></head>
<body style="font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fff;color:#111">
<main style="text-align:center;max-width:32rem;padding:2rem">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1>
<p style="margin:0 0 1.25rem">${body}</p>
<h2 style="font-size:1rem;margin:0 0 .5rem;color:#666">${titleOther}</h2>
<p style="margin:0;color:#666">${bodyOther}</p>
</main></body></html>`
}

export interface OAuthLoopback {
  /** 실제로 열린 포트 */
  port: number
  /** Supabase 에 넘길 redirectTo (state 포함) */
  redirectUri: string
  state: string
  /** 콜백이 올 때까지 기다린다. 취소·시간 초과는 거절 */
  waitForCallback: () => Promise<AuthCallback>
  /** 서버를 닫는다. 아직 콜백 전이면 대기 중인 약속을 취소로 끝낸다 */
  close: () => void
}

export interface OAuthLoopbackOptions {
  ports?: readonly number[]
  timeoutMs?: number
  state?: string
}

/** 한 포트로 듣기를 시도한다. 이미 쓰는 중이면 false */
function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.removeListener('listening', onListening)
      resolve(false)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, OAUTH_HOST)
  })
}

/** 콜백을 받을 루프백 서버를 띄운다 */
export async function startOAuthLoopback(
  options: OAuthLoopbackOptions = {}
): Promise<OAuthLoopback> {
  const ports = options.ports ?? OAUTH_PORTS
  const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS
  const state = options.state ?? createOAuthState()

  let settle!: (cb: AuthCallback) => void
  let fail!: (e: Error) => void
  const result = new Promise<AuthCallback>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // 아무도 기다리지 않는 사이에 거절되면 '처리되지 않은 Promise 거부' 로 남는다.
  // 빈 처리기를 붙여 두고, 원래 약속은 그대로 돌려준다
  result.catch(() => {})

  let done = false
  let port = 0
  let server: Server | undefined

  const shutdown = (): void => {
    if (!server) return
    server.close()
    // keep-alive 로 남은 연결까지 끊어야 프로세스가 붙잡히지 않는다
    server.closeAllConnections?.()
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const callback = parseAuthCallback(`http://${OAUTH_HOST}:${port}${req.url ?? '/'}`)
    if (!callback) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(callbackHtml(!callback.error))
    if (done) return
    done = true
    clearTimeout(timer)
    settle(callback)
    shutdown()
  }

  for (const candidate of ports) {
    const s = createServer(onRequest)
    if (await listen(s, candidate)) {
      server = s
      port = candidate
      break
    }
    s.close()
  }
  if (!server) {
    done = true
    fail(new Error(tr('auth.googlePortUnavailable')))
    throw new Error(tr('auth.googlePortUnavailable'))
  }

  const timer = setTimeout(() => {
    if (done) return
    done = true
    fail(new Error(tr('auth.googleTimeout')))
    shutdown()
  }, timeoutMs)
  timer.unref?.()

  return {
    port,
    redirectUri: redirectUriFor(port, state),
    state,
    waitForCallback: () => result,
    close: () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        fail(new Error(tr('auth.googleCancelled')))
      }
      clearTimeout(timer)
      shutdown()
    }
  }
}
