// 확장 서비스워커 chrome.cookies 보충 — 메인 쪽 처리(세션 쿠키 저장소)
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({}))

import {
  declaresCookies,
  extensionIdOfScope,
  runCookieOp,
  toChromeCookie
} from '../src/main/extensions/cookies-bridge'

const cookie = { name: 'PODGATE_D1', value: 'v', domain: '.adpick.co.kr', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: 123 }

function fakeSession(list = [cookie]) {
  return {
    cookies: {
      get: vi.fn(async () => list),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined)
    }
  } as never
}

describe('확장 쿠키 보충', () => {
  it('확장 서비스워커 scope 에서만 id 를 뽑는다', () => {
    expect(extensionIdOfScope('chrome-extension://gkbopfgdnonnkobieobkihdahfdhhihh/')).toBe('gkbopfgdnonnkobieobkihdahfdhhihh')
    expect(extensionIdOfScope('https://www.musinsa.com/')).toBeNull()
  })
  it('manifest 에 cookies 권한이 있어야 받아 준다', () => {
    expect(declaresCookies({ permissions: ['storage', 'cookies'] })).toBe(true)
    expect(declaresCookies({ permissions: ['storage'] })).toBe(false)
    expect(declaresCookies(null)).toBe(false)
  })
  it('get 은 첫 쿠키를 크롬 모양으로, 없으면 null', async () => {
    expect(await runCookieOp(fakeSession(), 'get', { url: 'https://www.adpick.co.kr', name: 'PODGATE_D1' })).toEqual(toChromeCookie(cookie as never))
    expect(await runCookieOp(fakeSession([]), 'get', { url: 'https://x.com', name: 'a' })).toBeNull()
  })
  it('getAll·remove·set 이 세션 쿠키 저장소로 간다', async () => {
    const ses = fakeSession()
    expect(await runCookieOp(ses, 'getAll', { domain: 'adpick.co.kr' })).toHaveLength(1)
    expect(await runCookieOp(ses, 'remove', { url: 'https://a.com', name: 'n' })).toEqual({ url: 'https://a.com', name: 'n', storeId: '0' })
    await runCookieOp(ses, 'set', { url: 'https://a.com', name: 'n', value: 'v', sameSite: 'lax' })
    expect((ses as { cookies: { set: ReturnType<typeof vi.fn> } }).cookies.set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a.com', name: 'n', value: 'v', sameSite: 'lax' }))
  })
})
