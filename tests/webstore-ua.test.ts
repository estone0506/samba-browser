// 크롬 웹스토어 UA 순수 로직 — 헤더용 UA 변환 · 호스트 판별 · navigator.userAgent 동기화

import { describe, it, expect, vi } from 'vitest'
import {
  chromeUserAgent,
  installWebstoreNavigatorUserAgent,
  isWebstoreUrl
} from '../src/main/browser/webstore-ua'

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) samba-browser/1.0.0 Chrome/129.0.0.0 Electron/39.0.0 Safari/537.36'

describe('chromeUserAgent — 앱·Electron 토큰만 걷어 낸다', () => {
  it('samba-browser·Electron 토큰을 지우고 정상 크롬 토큰은 남긴다', () => {
    const ua = chromeUserAgent(ELECTRON_UA)
    expect(ua).not.toContain('samba-browser')
    expect(ua).not.toContain('Electron')
    expect(ua).toContain('Chrome/129.0.0.0')
    expect(ua).toContain('Safari/537.36')
  })

  it('Gecko) 표식이 없으면 원문을 그대로 돌려준다', () => {
    expect(chromeUserAgent('이상한 UA')).toBe('이상한 UA')
  })
})

describe('isWebstoreUrl — 호스트만 본다', () => {
  it('웹스토어 호스트면 true', () => {
    expect(isWebstoreUrl('https://chromewebstore.google.com/detail/abc')).toBe(true)
  })

  it('다른 호스트·잘못된 URL 은 false', () => {
    expect(isWebstoreUrl('https://example.com/chromewebstore.google.com')).toBe(false)
    expect(isWebstoreUrl('not a url')).toBe(false)
  })
})

// --- installWebstoreNavigatorUserAgent -------------------------------------------
// 실제 WebContents 대신 on/getUserAgent/setUserAgent 만 흉내 낸 가짜를 쓴다(순수 로직 검증)

interface FakeNavDetails {
  url: string
  isMainFrame: boolean
}

function makeFakeWc(defaultUa: string): {
  wc: { getUserAgent: () => string; setUserAgent: (ua: string) => void; on: unknown }
  fireNavigation: (details: FakeNavDetails) => void
  uaHistory: string[]
} {
  const uaHistory: string[] = []
  let handler: ((details: FakeNavDetails) => void) | null = null
  const wc = {
    getUserAgent: () => defaultUa,
    setUserAgent: (ua: string) => uaHistory.push(ua),
    on: (event: string, listener: (details: FakeNavDetails) => void) => {
      if (event === 'did-start-navigation') handler = listener
    }
  }
  return {
    wc,
    fireNavigation: (details: FakeNavDetails) => handler?.(details),
    uaHistory
  }
}

describe('installWebstoreNavigatorUserAgent — 탭 이동에 맞춰 navigator UA 를 맞춘다', () => {
  it('웹스토어로 이동을 시작하면 순수 크롬 UA 로 바꾼다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    expect(uaHistory).toHaveLength(1)
    expect(uaHistory[0]).not.toContain('Electron')
    expect(uaHistory[0]).toContain('Chrome/129.0.0.0')
  })

  it('다른 호스트로 벗어나면 원래 UA 로 되돌린다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    fireNavigation({ url: 'https://example.com/', isMainFrame: true })
    expect(uaHistory).toEqual([expect.stringContaining('Chrome/129.0.0.0'), ELECTRON_UA])
  })

  it('서브프레임 이동은 무시한다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: false })
    expect(uaHistory).toHaveLength(0)
  })

  it('모바일 모드가 켜진 탭은 건드리지 않는다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    const isMobile = vi.fn(() => true)
    installWebstoreNavigatorUserAgent(wc as never, isMobile)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    expect(uaHistory).toHaveLength(0)
    expect(isMobile).toHaveBeenCalled()
  })
})
