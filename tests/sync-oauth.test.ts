import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  OAUTH_PORTS,
  OAUTH_REDIRECT_URIS,
  createOAuthState,
  parseAuthCallback,
  redirectUriFor,
  startOAuthLoopback
} from '../src/main/sync/oauth'

// 테스트는 127.0.0.1 루프백만 쓴다(외부 네트워크 없음)
const opened: { close: () => void }[] = []

afterEach(() => {
  for (const o of opened.splice(0)) o.close()
})

/** 포트 하나를 선점해 두는 더미 서버 */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end())
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

describe('parseAuthCallback', () => {
  it('code 가 있으면 code 와 state 를 돌려준다', () => {
    expect(parseAuthCallback('http://127.0.0.1:47612/callback?code=abc&state=s1')).toEqual({
      code: 'abc',
      state: 's1'
    })
  })

  it('프래그먼트(#access_token=…)만 오면 no-code 로 본다', () => {
    expect(
      parseAuthCallback('http://127.0.0.1:47612/callback#access_token=a&refresh_token=b')
    ).toEqual({ error: 'no-code' })
  })

  it('error 파라미터가 있으면 error 를 돌려준다', () => {
    expect(
      parseAuthCallback(
        'http://127.0.0.1:47613/callback?error=access_denied&error_description=%EA%B1%B0%EB%B6%80'
      )
    ).toEqual({ error: 'access_denied' })
  })

  it('경로가 /callback 이 아니면 null', () => {
    expect(parseAuthCallback('http://127.0.0.1:47612/other?code=x')).toBeNull()
  })

  it('다른 호스트·스킴이면 null(위조 차단)', () => {
    expect(parseAuthCallback('https://evil.com/callback?code=x')).toBeNull()
    expect(parseAuthCallback('http://localhost:47612/callback?code=x')).toBeNull()
    expect(parseAuthCallback('samba://auth?code=x')).toBeNull()
  })

  it('등록하지 않은 포트면 null', () => {
    expect(parseAuthCallback('http://127.0.0.1:9999/callback?code=x')).toBeNull()
  })

  it('URL 로 해석되지 않으면 null', () => {
    expect(parseAuthCallback('그냥 문자열')).toBeNull()
  })
})

describe('redirectUriFor / OAUTH_REDIRECT_URIS', () => {
  it('등록용 주소 3개를 포트 목록대로 만든다', () => {
    expect(OAUTH_REDIRECT_URIS).toEqual([
      'http://127.0.0.1:47612/callback',
      'http://127.0.0.1:47613/callback',
      'http://127.0.0.1:47614/callback'
    ])
    expect(OAUTH_PORTS.length).toBe(3)
  })

  it('state 를 주면 질의 문자열로 붙인다', () => {
    expect(redirectUriFor(47612, 'a b')).toBe('http://127.0.0.1:47612/callback?state=a%20b')
  })
})

describe('createOAuthState', () => {
  it('32바이트 무작위 값을 16진수로 준다', () => {
    const a = createOAuthState()
    const b = createOAuthState()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('startOAuthLoopback', () => {
  it('콜백을 받으면 결과를 넘기고 안내 HTML 로 응답한다', async () => {
    const loopback = await startOAuthLoopback()
    opened.push(loopback)
    expect(loopback.redirectUri).toBe(
      `http://127.0.0.1:${loopback.port}/callback?state=${loopback.state}`
    )

    const res = await fetch(`${loopback.redirectUri}&code=abc`)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('로그인 완료')
    expect(html).toContain('You can close this window')

    await expect(loopback.waitForCallback()).resolves.toEqual({
      code: 'abc',
      state: loopback.state
    })
  })

  it('앞 포트가 막혀 있으면 다음 포트로 넘어간다', async () => {
    const blocker = await occupy(OAUTH_PORTS[0])
    opened.push({ close: () => blocker.close() })
    const loopback = await startOAuthLoopback()
    opened.push(loopback)
    expect(loopback.port).toBe(OAUTH_PORTS[1])
  })

  it('콜백 경로가 아니면 404 를 주고 계속 기다린다', async () => {
    const loopback = await startOAuthLoopback()
    opened.push(loopback)
    const res = await fetch(`http://127.0.0.1:${loopback.port}/favicon.ico`)
    expect(res.status).toBe(404)
    await res.text()
    // 아직 끝나지 않았으므로 닫으면 취소 에러가 난다
    loopback.close()
    await expect(loopback.waitForCallback()).rejects.toThrow('취소')
  })

  it('시간이 지나면 시간 초과로 거절한다', async () => {
    const loopback = await startOAuthLoopback({ timeoutMs: 10 })
    opened.push(loopback)
    await expect(loopback.waitForCallback()).rejects.toThrow('시간이 초과')
  })

  it('쓸 수 있는 포트가 없으면 에러를 던진다', async () => {
    const blockers = await Promise.all(OAUTH_PORTS.map((p) => occupy(p)))
    for (const b of blockers) opened.push({ close: () => b.close() })
    await expect(startOAuthLoopback()).rejects.toThrow('포트')
  })
})
