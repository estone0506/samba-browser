// 하네스 브릿지 — 밖의 LangGraph 하네스가 이 앱의 도구를 HTTP 로 부르는 문.
//
// 규칙
// - 127.0.0.1 에만 바인딩한다. 외부에서는 닿을 수 없다
// - 모든 요청은 X-Samba-Token 이 설정의 토큰과 같아야 한다(길이가 같을 때만 상수 시간 비교)
// - 요청마다 도구 세션을 열고 닫는다. 채팅 실행이 도는 중이거나 다른 요청이 도는 중이면 409
// - 응답에 비밀값은 없다 — 도구가 돌려주는 본문 그대로다(도구가 값을 돌려주지 않는다)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ToolSession } from '../agent/runner'

export interface BridgeDeps {
  openSession: (onStep: (label: string, ok: boolean) => void) => ToolSession
  token: () => string
  toolTimeoutMs?: number
}

const DEFAULT_TOOL_TIMEOUT_MS = 90_000
const MAX_BODY_BYTES = 1024 * 1024

export class BridgeServer {
  private server: Server | null = null
  /** 지금 도구를 돌리는 중인가 — 한 손발이라 동시에 하나만 */
  private busy = false

  constructor(private readonly deps: BridgeDeps) {}

  listening(): boolean {
    return this.server?.listening === true
  }

  address(): { address: string; port: number } | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { address: a.address, port: a.port } : null
  }

  async start(port: number): Promise<number> {
    await this.stop()
    this.busy = false
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (e) => console.error('브릿지 서버 오류', e.message))
    const a = server.address()
    return a && typeof a === 'object' ? a.port : port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // keep-alive 소켓이 열려 있으면 close 콜백이 영영 안 온다 — 바로 끊는다
      server.closeAllConnections()
    })
  }

  private authorized(req: IncomingMessage): boolean {
    const given = req.headers['x-samba-token']
    const expected = this.deps.token()
    if (typeof given !== 'string' || expected === '') return false
    const givenBuf = Buffer.from(given)
    const expectedBuf = Buffer.from(expected)
    if (givenBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(givenBuf, expectedBuf)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return json(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return this.health(res)
    const m = /^\/tool\/([a-z0-9_]{1,64})$/.exec(url.pathname)
    if (req.method === 'POST' && m) return this.tool(m[1], req, res)
    return json(res, 404, { error: 'not found' })
  }

  private async health(res: ServerResponse): Promise<void> {
    if (this.busy) return json(res, 409, { error: 'busy' })
    let session: ToolSession
    try {
      session = this.deps.openSession(() => {})
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    try {
      json(res, 200, { ok: true, tools: session.names() })
    } finally {
      session.dispose()
    }
  }

  private async tool(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.busy) return json(res, 409, { error: 'busy' })
    let body: string
    try {
      body = await readBody(req)
    } catch (e: unknown) {
      if (e instanceof BodyTooLarge) return json(res, 413, { error: 'body too large' })
      return json(res, 400, { error: 'invalid body' })
    }
    let args: Record<string, unknown>
    try {
      const parsed: unknown = body.trim() === '' ? {} : JSON.parse(body)
      const a = (parsed as { args?: unknown }).args
      args = a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
    } catch {
      return json(res, 400, { error: 'invalid json' })
    }
    const steps: Array<{ label: string; ok: boolean }> = []
    let session: ToolSession
    try {
      session = this.deps.openSession((label, ok) => steps.push({ label, ok }))
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    if (!session.names().includes(name)) {
      session.dispose()
      return json(res, 404, { error: `unknown tool: ${name}` })
    }
    this.busy = true
    const timeoutMs = this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const callPromise = session.call(name, args)
    // 제한 시간 뒤에도 callPromise 는 계속 돌 수 있다 — 늦게 끝나도 세션 정리와 busy 해제는 한 번만
    let settledByTimer = false
    try {
      const result = await Promise.race([
        callPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            settledByTimer = true
            reject(new BridgeTimeout())
          }, timeoutMs)
        })
      ])
      json(res, 200, { ok: true, result, steps })
    } catch (e: unknown) {
      if (settledByTimer) {
        // 504 를 먼저 보낸다 — 세션은 아직 안 닫는다, callPromise 가 끝날 때 정리한다
        json(res, 504, { ok: false, error: 'tool timeout' })
      } else {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (settledByTimer) {
        callPromise
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            console.warn('브릿지: 제한 시간 뒤 늦게 끝난 도구 호출 실패', message)
          })
          .finally(() => {
            session.dispose()
            this.busy = false
          })
      } else {
        session.dispose()
        this.busy = false
      }
    }
  }
}

class BridgeTimeout extends Error {}
class BodyTooLarge extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true
          // 소켓을 끊지 않는다 — 핸들러가 413 을 보낸 뒤 끝낸다. 남은 데이터는 흘려보낸다
          req.removeAllListeners('data')
          req.resume()
          reject(new BodyTooLarge())
        }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) => {
      if (!settled) {
        settled = true
        reject(e)
      }
    })
  })
}
