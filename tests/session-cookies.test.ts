// 세션 쿠키 유지 — 만료 없는 쿠키만 만료를 얹어 되쓰고, 되쓴 쿠키로 반복하지 않는다

import { describe, it, expect, vi } from 'vitest'
import type { Cookie, CookiesSetDetails } from 'electron'
import {
  cookieUrl,
  duplicatedHostCookie,
  keepSessionCookies,
  mergeDuplicatedHostCookies,
  persistedCookie,
  SESSION_COOKIE_KEEP_DAYS
} from '../src/main/browser/session-cookies'

function cookie(over: Partial<Cookie> = {}): Cookie {
  return {
    name: 'app_atk',
    value: 'opaque-token',
    domain: '.musinsa.com',
    path: '/',
    secure: true,
    httpOnly: false,
    session: true,
    hostOnly: false,
    sameSite: 'no_restriction',
    ...over
  } as Cookie
}

describe('persistedCookie', () => {
  it('세션 쿠키에 14일 만료를 얹고 나머지는 그대로 둔다', () => {
    const now = 1_700_000_000_000
    const d = persistedCookie(cookie(), now)
    expect(d).toEqual({
      url: 'https://musinsa.com/',
      name: 'app_atk',
      value: 'opaque-token',
      domain: '.musinsa.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: Math.floor(now / 1000) + SESSION_COOKIE_KEEP_DAYS * 86400
    })
  })

  it('host-only 쿠키는 domain 을 빼고 되써서 같은 쿠키를 덮어쓴다(복제본을 만들지 않는다)', () => {
    const d = persistedCookie(cookie({ domain: 'www.shoemarker.co.kr', hostOnly: true, name: 'CKMAIN' }))
    expect(d).not.toHaveProperty('domain')
    expect(d?.url).toBe('https://www.shoemarker.co.kr/')
  })

  it('만료가 있는 쿠키·도메인 없는 쿠키는 건드리지 않는다', () => {
    expect(persistedCookie(cookie({ session: false, expirationDate: 1 }))).toBeNull()
    expect(persistedCookie(cookie({ domain: undefined }))).toBeNull()
  })

  it('cookieUrl 은 secure 여부와 경로를 따른다', () => {
    expect(cookieUrl({ domain: 'a.example', path: '/x', secure: false })).toBe('http://a.example/x')
    expect(cookieUrl({ domain: '.b.example', path: '/', secure: true })).toBe('https://b.example/')
  })
})

describe('keepSessionCookies', () => {
  function jar(): {
    fire: (c: Cookie, removed?: boolean) => void
    set: ReturnType<typeof vi.fn>
    jar: Parameters<typeof keepSessionCookies>[0]
  } {
    let handler: ((e: unknown, c: Cookie, cause: string, removed: boolean) => void) | null = null
    const set = vi.fn(async (_d: CookiesSetDetails) => {})
    const j = {
      on: (_ev: 'changed', l: typeof handler) => {
        handler = l
        return j
      },
      set
    }
    return { fire: (c, removed = false) => handler?.(null, c, 'explicit', removed), set, jar: j }
  }

  it('세션 쿠키가 생기면 만료를 얹어 되쓴다', () => {
    const { fire, set, jar: j } = jar()
    keepSessionCookies(j, { now: () => 1_700_000_000_000 })
    fire(cookie())
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][0]).toMatchObject({ name: 'app_atk', domain: '.musinsa.com' })
    expect((set.mock.calls[0][0] as CookiesSetDetails).expirationDate).toBeGreaterThan(0)
  })

  it('되쓴 쿠키(만료 있음)·지워진 쿠키에는 반응하지 않는다(무한 반복 없음)', () => {
    const { fire, set, jar: j } = jar()
    keepSessionCookies(j)
    fire(cookie({ session: false, expirationDate: 9_999_999_999 }))
    fire(cookie(), true)
    expect(set).not.toHaveBeenCalled()
  })

  it('저장이 실패해도 던지지 않고 이름만 알린다', async () => {
    const { fire, set, jar: j } = jar()
    set.mockRejectedValueOnce(new Error('boom'))
    const errors: string[] = []
    keepSessionCookies(j, { onError: (n) => errors.push(n) })
    fire(cookie())
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['app_atk'])
  })
})

describe('복제본 정리', () => {
  const host = (over: Partial<Cookie> = {}): Cookie =>
    cookie({ name: 'CKMAIN', value: 'v1', domain: 'www.shoemarker.co.kr', hostOnly: true, ...over })
  const copy = (over: Partial<Cookie> = {}): Cookie =>
    cookie({
      name: 'CKMAIN',
      value: 'v1',
      domain: '.www.shoemarker.co.kr',
      hostOnly: false,
      session: false,
      expirationDate: 2_000_000_000,
      ...over
    })

  it("'.www.' 복제본은 살아 있는 host-only 쌍둥이 값으로 합친다", () => {
    const t = host()
    expect(duplicatedHostCookie(copy(), [t, copy()])).toEqual({ twin: t })
  })

  it('www 가 아닌 도메인 쿠키는 같은 값의 쌍둥이가 있어도 건드리지 않는다(네이버 로그인 쿠키)', () => {
    const dom = copy({ name: 'NID_AUT', domain: '.naver.com' })
    const twin = host({ name: 'NID_AUT', domain: 'naver.com' })
    expect(duplicatedHostCookie(dom, [dom, twin])).toBeNull()
  })

  it("쌍둥이가 없어도 '.www.' 도메인이면 복제본이다(사이트가 지운 1회용 토큰)", () => {
    expect(duplicatedHostCookie(copy({ name: 'CKSUBPSIZELIST0' }), [])).toEqual({ twin: null })
  })

  it('사이트가 준 진짜 도메인 쿠키·세션 쿠키·host-only 는 건드리지 않는다', () => {
    const real = copy({ domain: '.musinsa.com', name: 'app_atk' })
    expect(duplicatedHostCookie(real, [real])).toBeNull()
    expect(duplicatedHostCookie(real, [real, host({ domain: 'musinsa.com', name: 'app_atk', value: 'other' })])).toBeNull()
    expect(duplicatedHostCookie(copy({ session: true, expirationDate: undefined }), [])).toBeNull()
    expect(duplicatedHostCookie(host(), [])).toBeNull()
  })

  it('지운 뒤 host-only 영구 쿠키 한 벌로 다시 쓴다(쌍둥이 값 우선)', async () => {
    const calls: string[] = []
    const sets: CookiesSetDetails[] = []
    const store = {
      get: async () => [host({ value: 'fresh' }), copy({ value: 'fresh' }), copy({ name: 'CKSUBPSIZELIST0', value: 'old' })],
      remove: async (url: string, name: string) => {
        calls.push(`remove ${url} ${name}`)
      },
      set: async (d: CookiesSetDetails) => {
        calls.push(`set ${d.name}`)
        sets.push(d)
      }
    }
    expect(await mergeDuplicatedHostCookies(store)).toBe(2)
    expect(calls).toEqual([
      'remove https://www.shoemarker.co.kr/ CKMAIN',
      'set CKMAIN',
      'remove https://www.shoemarker.co.kr/ CKSUBPSIZELIST0',
      'set CKSUBPSIZELIST0'
    ])
    expect(sets.every((d) => d.domain === undefined && d.expirationDate === 2_000_000_000)).toBe(true)
    expect(sets[0].value).toBe('fresh')
  })
})
