import { describe, it, expect, vi } from 'vitest'
import type { AuthState } from '../src/shared/sync'
import { AuthService } from '../src/main/sync/auth'
import {
  redirectUriFor,
  OAUTH_PORTS,
  type AuthCallback,
  type OAuthLoopback
} from '../src/main/sync/oauth'
import { createFakeBackend, FAKE_USER_ID } from './stubs/fake-backend'

/** 다음 마이크로/매크로 태스크까지 흘려 보낸다 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 루프백 서버를 흉내 내는 가짜 — 콜백 시점을 테스트가 직접 고른다 */
function fakeLoopback(state = 'state-1'): {
  loopback: OAuthLoopback
  arrive: (cb: AuthCallback) => void
  closed: () => boolean
} {
  let settle!: (cb: AuthCallback) => void
  const result = new Promise<AuthCallback>((resolve) => {
    settle = resolve
  })
  let closed = false
  return {
    loopback: {
      port: OAUTH_PORTS[0],
      redirectUri: redirectUriFor(OAUTH_PORTS[0], state),
      state,
      waitForCallback: () => result,
      close: () => {
        closed = true
      }
    },
    arrive: settle,
    closed: () => closed
  }
}

function setup(options: { configured?: boolean; state?: string } = {}): {
  auth: AuthService
  backend: ReturnType<typeof createFakeBackend>
  openExternal: ReturnType<typeof vi.fn>
  loop: ReturnType<typeof fakeLoopback>
  seen: AuthState[]
} {
  const backend = createFakeBackend()
  const openExternal = vi.fn(async () => {})
  const loop = fakeLoopback(options.state)
  const auth = new AuthService({
    backend,
    configured: options.configured ?? true,
    openExternal,
    startLoopback: async () => loop.loopback
  })
  const seen: AuthState[] = []
  auth.onStateChanged((s) => seen.push(s))
  return { auth, backend, openExternal, loop, seen }
}

describe('AuthService — 설정 전', () => {
  it('configured:false 면 상태에 그대로 드러나고 로그인은 막힌다', async () => {
    const { auth } = setup({ configured: false })
    expect(auth.state().configured).toBe(false)
    expect(auth.state().signedIn).toBe(false)
    await expect(auth.signIn('a@b.com', 'pw')).rejects.toThrow('설정')
    await expect(auth.signUp('a@b.com', 'pw')).rejects.toThrow('설정')
    await expect(auth.signInGoogle()).rejects.toThrow('설정')
  })

  it('설정 전에는 restore 가 아무 것도 하지 않는다', async () => {
    const { auth, backend } = setup({ configured: false })
    const spy = vi.spyOn(backend, 'currentUser')
    await auth.restore()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('AuthService — 이메일 로그인', () => {
  it('상태에는 토큰이 절대 들어가지 않는다', async () => {
    const { auth } = setup()
    await auth.signIn('me@example.com', 'pw')
    expect(Object.keys(auth.state()).sort()).toEqual([
      'configured',
      'deviceId',
      'email',
      'plan',
      'signedIn'
    ])
  })

  it('로그인에 성공하면 signedIn·email 이 채워지고 통지가 한 번 간다', async () => {
    const { auth, seen } = setup()
    const state = await auth.signIn('me@example.com', 'pw')
    expect(state).toEqual({
      signedIn: true,
      email: 'me@example.com',
      plan: 'free',
      deviceId: null,
      configured: true
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].signedIn).toBe(true)
  })

  it('가입도 같은 방식으로 로그인 상태를 만든다', async () => {
    const { auth } = setup()
    await auth.signUp('new@example.com', 'pw')
    expect(auth.state().signedIn).toBe(true)
    expect(auth.state().email).toBe('new@example.com')
  })

  it('이메일·비밀번호가 비면 백엔드를 부르지 않고 막는다', async () => {
    const { auth, backend } = setup()
    const spy = vi.spyOn(backend, 'signIn')
    await expect(auth.signIn('', 'pw')).rejects.toThrow('이메일')
    await expect(auth.signIn('a@b.com', '')).rejects.toThrow('비밀번호')
    expect(spy).not.toHaveBeenCalled()
  })

  it('로그아웃하면 다시 로그아웃 상태가 된다', async () => {
    const { auth, seen } = setup()
    await auth.signIn('me@example.com', 'pw')
    const state = await auth.signOut()
    expect(state.signedIn).toBe(false)
    expect(state.email).toBeUndefined()
    expect(seen).toHaveLength(2)
  })

  it('restore 는 이전 세션을 되살린다', async () => {
    const { auth, backend } = setup()
    await backend.signIn('saved@example.com', 'pw')
    const state = await auth.restore()
    expect(state.signedIn).toBe(true)
    expect(state.email).toBe('saved@example.com')
  })

  it('restore 가 실패해도 로그아웃 상태로 조용히 끝난다', async () => {
    const { auth, backend } = setup()
    vi.spyOn(backend, 'currentUser').mockRejectedValue(new Error('네트워크 없음'))
    const state = await auth.restore()
    expect(state.signedIn).toBe(false)
  })

  it('markExpired 는 즉시 로그아웃 상태로 되돌린다', async () => {
    const { auth, seen } = setup()
    await auth.signIn('me@example.com', 'pw')
    auth.markExpired()
    expect(auth.state().signedIn).toBe(false)
    expect(seen).toHaveLength(2)
    // 이미 로그아웃이면 통지를 더 보내지 않는다
    auth.markExpired()
    expect(seen).toHaveLength(2)
  })
})

describe('AuthService — 구글 OAuth(루프백)', () => {
  it('브라우저만 먼저 열고, 콜백이 와야 로그인이 끝난다', async () => {
    const { auth, openExternal, loop } = setup({ state: 'state-1' })
    const pending = auth.signInGoogle()
    await tick()

    expect(openExternal).toHaveBeenCalledTimes(1)
    const url = String(openExternal.mock.calls[0][0])
    expect(url).toContain(encodeURIComponent(loop.loopback.redirectUri))
    expect(auth.state().signedIn).toBe(false)

    loop.arrive({ code: 'abc', state: 'state-1' })
    const state = await pending
    expect(state.signedIn).toBe(true)
    expect(state.email).toBe('fake@example.com')
    expect(loop.closed()).toBe(true)
  })

  it('state 가 다르면 코드를 교환하지 않고 거절한다', async () => {
    const { auth, backend, loop } = setup({ state: 'state-1' })
    const spy = vi.spyOn(backend, 'exchangeCode')
    const pending = auth.signInGoogle()
    await tick()
    loop.arrive({ code: 'abc', state: '공격자-값' })
    await expect(pending).rejects.toThrow('state')
    expect(spy).not.toHaveBeenCalled()
    expect(auth.state().signedIn).toBe(false)
  })

  it('사용자가 거부하면 그 사유로 실패하고 상태는 그대로다', async () => {
    const { auth, loop } = setup({ state: 'state-1' })
    const pending = auth.signInGoogle()
    await tick()
    loop.arrive({ error: 'access_denied', state: 'state-1' })
    await expect(pending).rejects.toThrow('access_denied')
    expect(auth.state().signedIn).toBe(false)
  })
})

describe('AuthService — handleCallback', () => {
  it('콜백 주소의 code 로 로그인을 끝낸다', async () => {
    const { auth } = setup()
    const state = await auth.handleCallback(
      `http://127.0.0.1:${OAUTH_PORTS[0]}/callback?code=abc&state=state-1`
    )
    expect(state.signedIn).toBe(true)
  })

  it('error 콜백은 던지고 상태를 바꾸지 않는다', async () => {
    const { auth, seen } = setup()
    await expect(
      auth.handleCallback(`http://127.0.0.1:${OAUTH_PORTS[0]}/callback?error=access_denied`)
    ).rejects.toThrow('access_denied')
    expect(auth.state().signedIn).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('우리 콜백 주소가 아니면 던진다', async () => {
    const { auth } = setup()
    await expect(auth.handleCallback('https://evil.com/callback?code=x')).rejects.toThrow('콜백')
  })

  it('로그인된 사용자 id 는 백엔드가 준 값을 그대로 쓴다', async () => {
    const { auth, backend } = setup()
    const spy = vi.spyOn(backend, 'exchangeCode')
    await auth.handleCallback(`http://127.0.0.1:${OAUTH_PORTS[0]}/callback?code=abc`)
    await expect(spy.mock.results[0].value).resolves.toMatchObject({ userId: FAKE_USER_ID })
  })
})
