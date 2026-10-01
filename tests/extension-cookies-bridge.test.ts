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

describe('toChromeCookieChange', () => {
  it('쿠키 변경을 크롬 onChanged 모양으로 바꾸고 원인 이름의 - 를 _ 로 바꾼다', async () => {
    const { toChromeCookieChange } = await import('../src/main/extensions/cookies-bridge')
    const c = { name: 'sb_access_token', value: 'v', domain: '.shopback.co.kr', path: '/', secure: true, httpOnly: true, session: false } as unknown as Electron.Cookie
    const out = toChromeCookieChange(c, 'expired-overwrite', false)
    expect(out.removed).toBe(false)
    expect(out.cause).toBe('expired_overwrite')
    expect(out.cookie.name).toBe('sb_access_token')
    expect(out.cookie.domain).toBe('.shopback.co.kr')
  })
})

describe('toNavDetails', () => {
  it('최상위 프레임 이동 값을 크롬 webNavigation 모양으로 만든다', async () => {
    const { toNavDetails } = await import('../src/main/extensions/cookies-bridge')
    expect(toNavDetails(7, 'https://www.shopback.co.kr/', 1)).toEqual({ active: false,
      tabId: 7, url: 'https://www.shopback.co.kr/', frameId: 0, parentFrameId: -1, processId: 0,
      timeStamp: 1, transitionType: 'link', transitionQualifiers: []
    })
  })
})

describe('pickActionIconPath', () => {
  it('setIcon 의 path 가 문자열이면 그대로, 크기 표면 가장 큰 크기의 경로를 고른다', async () => {
    const { pickActionIconPath } = await import('../src/main/extensions/cookies-bridge')
    expect(pickActionIconPath('images/icon/Green-32.png')).toBe('images/icon/Green-32.png')
    expect(pickActionIconPath({ '16': 'a16.png', '32': 'a32.png' })).toBe('a32.png')
    expect(pickActionIconPath({})).toBeNull()
    expect(pickActionIconPath(undefined)).toBeNull()
  })
})

// 확장을 올린 직후 0.6초쯤 startWorkerForScope 는 "Failed to start service worker." 로 즉시 거부한다
// (실측 2026-10-01, Electron 39.8.10). 그 사이에 온 이동 알림을 버리면 확장은 복원된 탭의 첫 이동을
// 놓친다. 이미 돌고 있는 워커를 먼저 쓰고, 없으면 짧게 다시 시도해야 한다.
describe('서비스워커 집기 — 적재 직후 거부 구간', () => {
  interface SwFake {
    startWorkerForScope: ReturnType<typeof vi.fn>
    getAllRunning: ReturnType<typeof vi.fn>
    getWorkerFromVersionID: ReturnType<typeof vi.fn>
  }
  const scope = 'chrome-extension://gkbopfgdnonnkobieobkihdahfdhhihh/'
  const makeSes = (sw: SwFake): never =>
    ({
      extensions: {
        getAllExtensions: () => [
          {
            id: 'gkbopfgdnonnkobieobkihdahfdhhihh',
            manifest: { background: { service_worker: 'sw.js' } }
          }
        ]
      },
      serviceWorkers: sw
    }) as never

  const warm = async (ses: never): Promise<void> => {
    const { warmExtensionWorkers } = await import('../src/main/extensions/cookies-bridge')
    vi.useFakeTimers()
    try {
      const p = warmExtensionWorkers(ses)
      // 재시도 간격(300ms × 2) + 준비 신호 대기(SW_READY_TIMEOUT_MS = 5000)
      await vi.advanceTimersByTimeAsync(7000)
      await p
    } finally {
      vi.useRealTimers()
    }
  }

  it('거부되더라도 이미 돌고 있는 워커를 쓴다 — 띄우기를 아예 부르지 않는다', async () => {
    const worker = { send: vi.fn(), scope }
    const sw: SwFake = {
      startWorkerForScope: vi.fn(async () => {
        throw new Error('Failed to start service worker.')
      }),
      getAllRunning: vi.fn(() => ({ 0: { scope } })),
      getWorkerFromVersionID: vi.fn(() => worker)
    }
    await warm(makeSes(sw))
    expect(sw.startWorkerForScope).not.toHaveBeenCalled()
    expect(sw.getWorkerFromVersionID).toHaveBeenCalledWith(0)
  })

  it('돌고 있는 워커가 없으면 거부를 넘기고 다시 시도한다', async () => {
    let calls = 0
    const sw: SwFake = {
      startWorkerForScope: vi.fn(async () => {
        calls += 1
        if (calls < 3) throw new Error('Failed to start service worker.')
        return { send: vi.fn(), scope }
      }),
      getAllRunning: vi.fn(() => ({})),
      getWorkerFromVersionID: vi.fn(() => undefined)
    }
    await warm(makeSes(sw))
    expect(calls).toBe(3)
  })

  it('다른 스코프가 돌고 있어도 그 워커를 집지 않는다', async () => {
    const sw: SwFake = {
      startWorkerForScope: vi.fn(async () => ({ send: vi.fn(), scope })),
      getAllRunning: vi.fn(() => ({ 0: { scope: 'https://www.musinsa.com/' } })),
      getWorkerFromVersionID: vi.fn(() => ({ send: vi.fn() }))
    }
    await warm(makeSes(sw))
    expect(sw.getWorkerFromVersionID).not.toHaveBeenCalled()
    expect(sw.startWorkerForScope).toHaveBeenCalledTimes(1)
  })

  it('끝까지 안 되면 조용히 포기한다 — 예외를 밖으로 던지지 않는다', async () => {
    const sw: SwFake = {
      startWorkerForScope: vi.fn(async () => {
        throw new Error('Failed to start service worker.')
      }),
      getAllRunning: vi.fn(() => ({})),
      getWorkerFromVersionID: vi.fn(() => undefined)
    }
    await expect(warm(makeSes(sw))).resolves.toBeUndefined()
    expect(sw.startWorkerForScope).toHaveBeenCalledTimes(3)
  })
})
