// 계정 인증. 이메일 가입·로그인과 구글 OAuth(127.0.0.1 루프백)를 담당한다.
// 이 클래스가 들고 있는 AuthState 에는 토큰이 절대 들어가지 않는다 —
// refresh token 은 session-store 가 safeStorage 로 감싸 디스크에만 둔다

import type { AuthState } from '../../shared/sync'
import type { SyncBackend } from './backend'
import {
  parseAuthCallback,
  startOAuthLoopback,
  type AuthCallback,
  type OAuthLoopback
} from './oauth'

export interface AuthDeps {
  /** Supabase 설정이 없으면 null */
  backend: SyncBackend | null
  /** 기본 브라우저로 주소를 연다(shell.openExternal) */
  openExternal: (url: string) => Promise<void>
  /** .env 가 채워져 있는가 */
  configured: boolean
  /** 콜백 수신용 루프백 서버 시작 — 테스트에서 가짜로 갈아 끼운다 */
  startLoopback?: () => Promise<OAuthLoopback>
}

const SIGNED_OUT = { signedIn: false as const, plan: 'free' as const, deviceId: null }

export class AuthService {
  private readonly deps: AuthDeps
  private readonly listeners = new Set<(s: AuthState) => void>()
  private current: AuthState
  /** 진행 중인 구글 로그인 — 새로 시작하면 이전 것은 취소한다 */
  private pending: OAuthLoopback | null = null

  constructor(deps: AuthDeps) {
    this.deps = deps
    this.current = { ...SIGNED_OUT, configured: deps.configured && !!deps.backend }
  }

  state(): AuthState {
    return { ...this.current }
  }

  onStateChanged(fn: (s: AuthState) => void): void {
    this.listeners.add(fn)
  }

  /** 앱 시작 시 저장된 세션을 되살린다. 실패는 로그아웃으로 본다 */
  async restore(): Promise<AuthState> {
    if (!this.current.configured || !this.deps.backend) return this.state()
    try {
      const user = await this.deps.backend.currentUser()
      this.apply(user)
    } catch (e: unknown) {
      // 사유만 남긴다 — 토큰·값은 절대 로그에 넣지 않는다
      console.warn('세션 복구 실패', e instanceof Error ? e.message : String(e))
      this.setSignedOut()
    }
    return this.state()
  }

  async signUp(email: string, password: string): Promise<AuthState> {
    const backend = this.requireBackend()
    this.requireCredentials(email, password)
    this.apply(await backend.signUp(email, password))
    return this.state()
  }

  async signIn(email: string, password: string): Promise<AuthState> {
    const backend = this.requireBackend()
    this.requireCredentials(email, password)
    this.apply(await backend.signIn(email, password))
    return this.state()
  }

  /**
   * 구글 로그인. 기본 브라우저를 열고 127.0.0.1 루프백으로 콜백을 기다린다.
   * 사용자가 브라우저에서 끝낼 때까지(최대 5분) 이 약속은 끝나지 않는다
   */
  async signInGoogle(): Promise<AuthState> {
    const backend = this.requireBackend()
    // 이전 시도가 남아 있으면 정리한다(포트를 붙잡고 있지 않게)
    this.cancelPending()
    const loopback = await (this.deps.startLoopback ?? startOAuthLoopback)()
    this.pending = loopback
    try {
      const url = await backend.oauthUrl(loopback.redirectUri)
      await this.deps.openExternal(url)
      const callback = await loopback.waitForCallback()
      return await this.complete(callback, loopback.state)
    } finally {
      loopback.close()
      if (this.pending === loopback) this.pending = null
    }
  }

  /** 콜백 주소를 직접 받아 로그인을 끝낸다(루프백 서버가 부르는 경로와 동일) */
  async handleCallback(url: string): Promise<AuthState> {
    const callback = parseAuthCallback(url)
    if (!callback) throw new Error('구글 로그인 콜백 주소가 아닙니다')
    return this.complete(callback, this.pending?.state)
  }

  async signOut(): Promise<AuthState> {
    this.cancelPending()
    try {
      await this.deps.backend?.signOut()
    } catch (e: unknown) {
      // 서버 로그아웃이 실패해도 로컬은 로그아웃 상태로 만든다
      console.warn('원격 로그아웃 실패', e instanceof Error ? e.message : String(e))
    }
    this.setSignedOut()
    return this.state()
  }

  /** 401(토큰 만료·기기 원격 로그아웃) 감지 시 sync 엔진이 부른다 */
  markExpired(): void {
    this.cancelPending()
    this.setSignedOut()
  }

  // --- 내부 -----------------------------------------------------------------

  private requireBackend(): SyncBackend {
    if (!this.deps.configured || !this.deps.backend) {
      throw new Error(
        'Supabase 설정이 필요합니다. docs/supabase-설정.md 를 보고 .env 를 채워 주세요'
      )
    }
    return this.deps.backend
  }

  private requireCredentials(email: string, password: string): void {
    if (!email.trim()) throw new Error('이메일을 입력해 주세요')
    if (!password) throw new Error('비밀번호를 입력해 주세요')
  }

  /** 콜백 한 건을 검증하고 코드를 세션으로 바꾼다 */
  private async complete(callback: AuthCallback, expectedState?: string): Promise<AuthState> {
    const backend = this.requireBackend()
    // 우리가 심어 둔 state 와 다르면 남이 만든 콜백이다
    if (expectedState && callback.state !== expectedState) {
      throw new Error('구글 로그인 state 값이 일치하지 않습니다')
    }
    if (callback.error) throw new Error(`구글 로그인 실패: ${callback.error}`)
    if (!callback.code) throw new Error('구글 로그인 실패: no-code')
    this.apply(await backend.exchangeCode(callback.code))
    return this.state()
  }

  private cancelPending(): void {
    const loopback = this.pending
    this.pending = null
    loopback?.close()
  }

  private apply(user: { userId: string; email: string } | null): void {
    if (!user) {
      this.setSignedOut()
      return
    }
    this.next({
      signedIn: true,
      email: user.email,
      plan: 'free',
      deviceId: this.current.deviceId,
      configured: this.current.configured
    })
  }

  private setSignedOut(): void {
    this.next({ ...SIGNED_OUT, configured: this.current.configured })
  }

  /** 실제로 달라졌을 때만 통지한다 */
  private next(state: AuthState): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return
    this.current = state
    for (const fn of this.listeners) {
      try {
        fn(this.state())
      } catch (e: unknown) {
        console.error('인증 상태 통지 실패', e instanceof Error ? e.message : String(e))
      }
    }
  }
}
