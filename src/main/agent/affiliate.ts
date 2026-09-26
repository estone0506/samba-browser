// 제휴 적립 링크 — 애드픽(포인트백 for ADPICK) 확장 팝업이 하는 요청을 프로필 세션으로 대신 한다.
//
// 왜: SSG 는 애드픽 적립 추적 링크로 상품에 다시 들어가 결제해야 포인트가 붙는다(사용자 규칙 2026-09-26).
// 팝업은 서버 응답에 10초쯤 걸려 그사이 탭이 바뀌면 닫혀 버리고, 저장 스크립트에는 fetch 가 없다.
// 애드픽 로그인 쿠키는 그 프로필 세션에만 있으므로 반드시 그 세션으로 부른다.
import type { Session } from 'electron'

export const ADPICK_ADDLINK_URL = 'https://adpick.co.kr/apis/shopping_addlink.php?ref=chrome'
// 애드픽 서버가 링크 하나 만드는 데 10초 안팎 걸린다(실측 10.5초)
export const ADPICK_TIMEOUT_MS = 30_000

/** 애드픽 링크 결과 — 스크립트에 돌려주는 값만(쿠키·계정 정보 없음) */
export interface AdpickLink {
  ok: boolean
  trackinglink: string | null
  slink: string | null
  percent: string | null
  product_code: string | null
  note: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** API 응답 → 결과(순수 함수). 적립 링크가 없으면 ok:false */
export function parseAdpickResponse(raw: unknown): AdpickLink {
  const d = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const tracking = str(d.trackinglink)
  const ok = String(d.status) === '1' && !!tracking && /^https:\/\//.test(tracking)
  return {
    ok,
    trackinglink: ok ? tracking : null,
    slink: str(d.slink),
    percent: str(d.percent),
    product_code: str(d.product_code),
    note: ok ? null : 'no tracking link (not logged in to adpick, or unsupported mall)'
  }
}

/** 상품 주소의 애드픽 적립 링크를 그 프로필 세션으로 받는다 */
export async function adpickTrackingLink(ses: Session, productUrl: string): Promise<AdpickLink> {
  if (!/^https:\/\//.test(productUrl)) return parseAdpickResponse(null)
  const url = `${ADPICK_ADDLINK_URL}&product_url=${encodeURIComponent(productUrl)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ADPICK_TIMEOUT_MS)
  try {
    const res = await ses.fetch(url, { signal: ctrl.signal, credentials: 'include' })
    if (!res.ok) return { ...parseAdpickResponse(null), note: `adpick http ${res.status}` }
    return parseAdpickResponse(await res.json())
  } catch (e: unknown) {
    return { ...parseAdpickResponse(null), note: `adpick request failed: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}
