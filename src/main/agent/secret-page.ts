// 웹 결제 비밀번호 키패드 탐지.
//
// 무신사 결제 팝업·NICE pinCert·KCP·토스/카카오/페이코 웹 결제창처럼
// 0~9 숫자 키패드로 결제 비밀번호를 받는 화면에서는 AI 가 숫자를 눌러선 안 된다.
// 모델은 비밀번호를 모르므로 맞출 수 없고, 잘못 누르면 계정이 잠긴다.
//
// 이 파일은 "지금 화면이 비밀 키패드인가" 만 판정한다.
// 입력 내용(값)은 어디에서도 읽지 않는다 — 있는지·몇 개인지만 센다.

import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { KeypadSignals } from '../../shared/snapshot'

export type { KeypadSignals }

// 숫자 키패드로 볼 최소 버튼 수(0~9)
export const DIGIT_BUTTON_MIN = 10

// 결제 비밀번호 화면에서 흔히 보이는 문구
export const SECRET_KEYPAD_TEXT_RE =
  /결제\s?비밀번호|비밀번호\s?6\s?자리|비밀번호를\s?입력|\bPIN\b|간편\s?비밀번호/i

// 알려진 PIN 인증 경로. 숫자가 이미지로 그려져 DOM 으로 못 세는 화면을 여기서 잡는다
export const PIN_URL_PATTERNS: readonly RegExp[] = [
  /pinCert/i,
  /\/pin\//i,
  /simplepay.*password/i,
  /kakaopay.*pw/i,
  /toss.*pin/i,
  /payco.*pin/i
]

/** 주소가 알려진 PIN 인증 경로인가 */
export function isPinAuthUrl(url: string): boolean {
  return PIN_URL_PATTERNS.some((re) => re.test(url))
}

// 판정 근거. 로그·넘김 카드 문구에만 쓰고 모델에게는 넘기지 않는다
export type SecretKeypadReason = 'digit-keypad' | 'pin-url' | 'pin-field'

/**
 * 비밀 키패드 화면 판정(순수 함수).
 * 세 조건 중 하나라도 맞으면 근거를, 아니면 null 을 돌려준다
 */
export function secretKeypadReason(signals: KeypadSignals): SecretKeypadReason | null {
  if (isPinAuthUrl(signals.url)) return 'pin-url'
  if (signals.digitButtons >= DIGIT_BUTTON_MIN && SECRET_KEYPAD_TEXT_RE.test(signals.text)) {
    return 'digit-keypad'
  }
  if (signals.pinField) return 'pin-field'
  return null
}

/** 비밀 키패드 화면인가(순수 함수) */
export function isSecretKeypad(signals: KeypadSignals): boolean {
  return secretKeypadReason(signals) !== null
}

// 스캔 결과 캐시 수명 — 도구 호출 1회에 스캔도 1회만 돌게 한다
export const SECRET_KEYPAD_CACHE_MS = 500

export interface SecretKeypadGateDeps {
  // 페이지에서 신호를 읽는다(기본은 page bridge)
  read: (tab: Tab) => Promise<KeypadSignals>
  // 페이지를 읽지 못했을 때 주소만으로 판정하기 위한 통로
  urlOf: (tab: Tab) => string
  now?: () => number
  cacheMs?: number
}

export interface SecretKeypadGate {
  /** 탭이 비밀 키패드 화면이면 근거, 아니면 null. fresh 면 캐시를 건너뛴다 */
  check: (tab: Tab, opts?: { fresh?: boolean }) => Promise<SecretKeypadReason | null>
  /** 캐시 비우기(테스트·탭 정리용) */
  clear: () => void
}

/**
 * 탭 단위 스캐너. 같은 탭을 짧은 시간 안에 여러 번 물어도 페이지는 한 번만 읽는다.
 * 페이지를 읽지 못하면(이동 중·팝업 종료) 주소만으로 판정한다 —
 * 읽기 실패를 이유로 일반 페이지의 조작까지 막지는 않는다
 */
export function createSecretKeypadGate(deps: SecretKeypadGateDeps): SecretKeypadGate {
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? SECRET_KEYPAD_CACHE_MS
  const cache = new Map<string, { at: number; reason: SecretKeypadReason | null }>()

  return {
    check: async (tab, opts) => {
      const key = tab.id
      if (!opts?.fresh) {
        const hit = cache.get(key)
        if (hit && now() - hit.at < cacheMs) return hit.reason
      }
      let reason: SecretKeypadReason | null
      try {
        reason = secretKeypadReason(await deps.read(tab))
      } catch {
        // 주소 조회마저 실패하면(탭 종료) 조작을 막지 않는다 — 읽기 실패로 일반 페이지를
        // 막아 버리는 쪽이 더 나쁘다
        let url = ''
        try {
          url = deps.urlOf(tab)
        } catch {
          url = ''
        }
        reason = isPinAuthUrl(url) ? 'pin-url' : null
      }
      cache.set(key, { at: now(), reason })
      return reason
    },
    clear: () => cache.clear()
  }
}

/** 앱에서 쓰는 스캐너 하나(도구들이 공유해 캐시도 함께 쓴다) */
export const secretKeypadGate = createSecretKeypadGate({
  read: (tab) => pageBridge.keypadSignals(tab),
  urlOf: (tab) => (tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL())
})
