// 크롬 웹스토어에만 크롬처럼 보이는 UA 를 보낸다.
//
// 왜 필요한가
// Electron 기본 UA 에는 `samba-browser/1.0.0 … Electron/39.0.0` 제품 토큰이 섞여 있고,
// 웹스토어는 이런 UA 를 보면 "이 브라우저는 지원되지 않습니다" 배너를 띄우거나
// "Chrome에 추가" 버튼 자리를 다른 안내로 바꿔 버린다. 그러면 설치 버튼 자체가 없어진다.
//
// 범위는 웹스토어 호스트 요청으로 못 박는다 — 다른 사이트의 UA 는 건드리지 않는다.
// (모바일 모드의 UA 교체는 src/main/browser/emulation.ts 가 webContents 단위로 따로 한다)

import type { Session } from 'electron'
import { WEBSTORE_HOST } from '../../shared/extensions'

/** webRequest 필터 — 이 패턴에 걸리는 요청만 UA 를 갈아 끼운다 */
export const WEBSTORE_URL_PATTERNS = [`https://${WEBSTORE_HOST}/*`]

// 크롬 UA 의 `(KHTML, like Gecko)` 뒤에 올 수 있는 정상 제품 토큰.
// 여기 없는 `이름/버전` 토큰(앱 이름·Electron)은 걷어 낸다
const CHROME_TOKENS = /^(Chrome|Chromium|Safari|CriOS|Version|Edg|Mobile)\//i

/**
 * Electron 기본 UA 에서 앱·Electron 제품 토큰을 걷어 내 순수 크롬 UA 로 만든다.
 * 플랫폼 부분(`Mozilla/5.0 (…) AppleWebKit/537.36 (KHTML, like Gecko)`)은 그대로 둔다
 */
export function chromeUserAgent(ua: string): string {
  const marker = 'Gecko)'
  const at = ua.indexOf(marker)
  if (at < 0) return ua.trim()
  const head = ua.slice(0, at + marker.length)
  const tail = ua
    .slice(at + marker.length)
    .split(/\s+/)
    .filter(Boolean)
    // 슬래시가 없는 토큰(`Mobile` 등)은 버전 표기가 아니므로 그대로 둔다
    .filter((token) => !token.includes('/') || CHROME_TOKENS.test(token))
  return [head, ...tail].join(' ').trim()
}

/**
 * 세션에 웹스토어 전용 UA 교체를 건다.
 * onBeforeSendHeaders 는 세션당 리스너가 하나뿐이라 파티션마다 1회만 걸어야 한다
 * (호출부인 tab-manager 의 hardenSession 이 파티션 단위로 한 번만 부른다)
 */
export function installWebstoreUserAgent(ses: Session): void {
  const ua = chromeUserAgent(ses.getUserAgent())
  ses.webRequest.onBeforeSendHeaders({ urls: WEBSTORE_URL_PATTERNS }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'User-Agent': ua } })
  })
}
