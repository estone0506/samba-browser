// 문자 인증 자동 입력 오케스트레이션 + ARS 수신 감지.
//
// 안전 규칙(3단계 Global Constraints):
//  - 문자 본문은 `watchSms` 밖으로 나오지 않는다. 여기서 다루는 값은 숫자 코드와
//    발신번호 뒷 4자리뿐이고, 기록(`record`)에도 그 둘만 남는다.
//  - 인증번호는 모델에게 돌려주지 않는다 — 페이지에 바로 채운다(도구는 마스킹만 본다).
//  - ARS(전화 인증)는 **감지·안내만** 한다. 자동 응답·키패드 입력은 5단계 몫이다.

import { AUTH_TIMEOUT_MS } from '../../shared/phone'
import type { AuthEventDto, AuthEventMethod, PhoneAuthWaitingDto } from '../../shared/phone'
import type { PageElement, PageSnapshot } from '../../shared/snapshot'
import { shellArgs, type AdbRunner } from './adb'
import { watchSms, type SmsCandidate } from './sms'

// --- 인증번호 입력칸 탐지(순수) ----------------------------------------------

// 인증 문맥 문구(이름·라벨·placeholder 모두 같은 규칙으로 본다)
const CODE_HINT_RE =
  /인증\s?번호|확인\s?번호|verif(?:y|ication)|auth(?:_|-)?(?:code|num)|\botp\b|one[-_ ]?time|\bcode\b|sms.?code/i
// 숫자 칸이라도 인증과 무관한 칸(우편번호·쿠폰·주문번호 등)은 후보에서 뺀다
const NOT_CODE_RE =
  /zip|post(?:al)?[-_ ]?code|coupon|promo|referr|discount|barcode|country|area[-_ ]?code|card|birth|주민|우편|쿠폰|카드/i
// 인증번호를 받을 수 있는 입력칸의 inputType(비밀·체크박스 등은 제외)
const TEXTUAL_TYPES = ['text', 'tel', 'number', 'search', '']
// 이 둘은 문구가 없어도 인증번호 칸일 가능성이 높다
const NUMERIC_TYPES = ['tel', 'number']

/** 후보 점수 — 0 이면 후보가 아니다 */
function scoreField(e: PageElement): number {
  if (e.isSecret) return 0
  const tag = e.tag.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') return 0
  const type = (e.inputType ?? '').toLowerCase()
  if (tag === 'input' && !TEXTUAL_TYPES.includes(type)) return 0

  const name = e.name ?? ''
  const text = e.text ?? ''
  if (NOT_CODE_RE.test(name) || NOT_CODE_RE.test(text)) return 0

  let score = 0
  if (CODE_HINT_RE.test(name)) score += 3
  if (CODE_HINT_RE.test(text)) score += 2
  if (NUMERIC_TYPES.includes(type)) score += 1
  // 문구가 전혀 없는 숫자 칸도 마지막 후보로는 인정한다
  if (score === 1) return 1
  return score
}

/**
 * 웹 스냅샷에서 인증번호 입력칸 후보를 고른다(순수).
 * 비밀 입력칸(isSecret)은 절대 고르지 않는다 — 인증번호를 비밀번호 칸에 넣지 않기 위함이다
 */
export function findCodeField(snapshot: PageSnapshot): PageElement | null {
  let best: { el: PageElement; score: number } | null = null
  for (const e of snapshot.elements) {
    const score = scoreField(e)
    if (score <= 0) continue
    // 점수가 같으면 문서에서 먼저 나온 칸을 쓴다
    if (!best || score > best.score) best = { el: e, score }
  }
  return best?.el ?? null
}

// --- 인증 흐름 ---------------------------------------------------------------

export interface AuthFlowDeps {
  adb: AdbRunner
  serials: () => string[]
  siteHost: string
  jobId?: string
  snapshot: () => Promise<PageSnapshot>
  fillValue: (elementId: number, value: string) => Promise<string>
  submit: (elementId: number) => Promise<string>
  autoSubmit: boolean
  screenshot: (serial: string) => Promise<Buffer>
  readCodeFromImage: (png: Buffer) => Promise<string | null>
  record: (e: Omit<AuthEventDto, 'id'>) => void
  notify: (dto: PhoneAuthWaitingDto) => void
  now: () => number
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  /** serial → 저장소의 폰 id(기록·통지용). 없으면 null 로 남긴다 */
  phoneIdOf?: (serial: string) => number | null
}

export type AuthFlowResult =
  | { ok: true; method: AuthEventMethod; elapsedMs: number }
  | { ok: false; reason: 'no-field' | 'timeout' | 'fill-failed' | 'no-phone' }

// page-bridge 의 fillValue/submit 이 실패했을 때 돌려주는 문구들
const FILL_FAILED_RE = /fail|not found|gone|error|refused/i

/** 화면 읽기로 구한 코드 한 건(발신번호를 알 수 없으므로 senderTail 은 비운다) */
function screenCandidate(code: string, at: number): SmsCandidate {
  return { code, senderTail: '', score: 0, dateMs: at }
}

/**
 * 문자 인증을 끝까지 수행한다.
 * 후보 선정 → 대기 통지 → 문자 감시(3대 동시) → 입력 → 자동 제출 →
 * 실패 시 스크린샷 + Visual 폴백 → 기록 → 완료 통지 순이다
 */
export async function runSmsAuth(deps: AuthFlowDeps): Promise<AuthFlowResult> {
  const started = deps.now()
  const field = findCodeField(await deps.snapshot())
  // 후보가 없으면 폴링을 아예 시작하지 않는다(폰을 건드리지 않는다)
  if (!field) return { ok: false, reason: 'no-field' }

  const serials = deps.serials()
  if (serials.length === 0) return { ok: false, reason: 'no-phone' }

  // 화면 읽기로 코드를 얻었는지 — 기록할 method 가 달라진다
  let viaScreen = false
  const readScreen = async (serial: string): Promise<SmsCandidate | null> => {
    try {
      const png = await deps.screenshot(serial)
      if (png.length === 0) return null
      const code = await deps.readCodeFromImage(png)
      if (!code) return null
      viaScreen = true
      return screenCandidate(code, deps.now())
    } catch {
      // 캡처 실패는 조용히 넘긴다 — 오류 객체에 화면 내용이 실릴 수 있다
      return null
    }
  }

  const notify = (waiting: boolean, phoneId: number | null): void =>
    deps.notify({ waiting, kind: 'sms', siteHost: deps.siteHost, phoneId })

  notify(true, null)

  let hit: (SmsCandidate & { serial: string }) | null = null
  try {
    hit = await watchSms({
      adb: deps.adb,
      serials: deps.serials,
      siteHost: deps.siteHost,
      now: deps.now,
      sleep: deps.sleep,
      cancelled: deps.cancelled,
      // 문자함·알림 로그가 모두 막힌 폰은 화면 읽기로 우회한다
      screenFallback: readScreen
    })

    // 3분 안에 문자가 없으면 연결된 폰을 차례로 캡처해 Visual 로 읽는다
    if (!hit && !deps.cancelled?.()) {
      for (const serial of deps.serials()) {
        const seen = await readScreen(serial)
        if (seen) {
          hit = { ...seen, serial }
          break
        }
      }
    }

    const phoneId = hit ? (deps.phoneIdOf?.(hit.serial) ?? null) : null
    const method: AuthEventMethod = viaScreen ? 'visual' : 'sms_query'
    const base = {
      jobId: deps.jobId ?? null,
      phoneId,
      kind: 'sms' as const,
      siteHost: deps.siteHost,
      method,
      at: deps.now()
    }

    if (!hit) {
      deps.record({
        ...base,
        method: 'sms_query',
        ok: false,
        elapsedMs: deps.now() - started,
        code: null,
        senderTail: null
      })
      return { ok: false, reason: 'timeout' }
    }

    const filled = await deps.fillValue(field.id, hit.code)
    if (FILL_FAILED_RE.test(filled)) {
      deps.record({
        ...base,
        ok: false,
        elapsedMs: deps.now() - started,
        code: hit.code,
        senderTail: hit.senderTail || null
      })
      return { ok: false, reason: 'fill-failed' }
    }

    if (deps.autoSubmit) await deps.submit(field.id)

    const elapsedMs = deps.now() - started
    deps.record({
      ...base,
      ok: true,
      elapsedMs,
      code: hit.code,
      senderTail: hit.senderTail || null
    })
    return { ok: true, method, elapsedMs }
  } finally {
    notify(false, hit ? (deps.phoneIdOf?.(hit.serial) ?? null) : null)
  }
}

// --- ARS(전화 인증) 수신 감지 -------------------------------------------------

/** 통화 상태를 읽는 dumpsys 명령 */
export const CALL_STATE_ARGS = ['dumpsys', 'telephony.registry']

const CALL_STATE_RE = /mCallState=(\d)/

/** 통화 상태 조회 — 0 대기 · 1 수신중 · 2 통화중. 조회 실패는 0 으로 본다 */
export async function callState(adb: AdbRunner, serial: string): Promise<0 | 1 | 2> {
  const res = await adb.run(shellArgs(serial, CALL_STATE_ARGS), 8000)
  if (res.code !== 0) return 0
  const raw = Number(CALL_STATE_RE.exec(res.stdout)?.[1] ?? '0')
  return raw === 1 ? 1 : raw === 2 ? 2 : 0
}

/** 지금 전화가 오고 있는 폰의 serial. 없으면 null(자동 응답은 하지 않는다) */
export async function detectIncomingCall(
  adb: AdbRunner,
  serials: string[]
): Promise<string | null> {
  for (const serial of serials) {
    if ((await callState(adb, serial)) === 1) return serial
  }
  return null
}

/** ARS 감시 주기 3초(인증 대기 중에만 돈다) */
export const ARS_POLL_INTERVAL_MS = 3000
/** 인증 대기 상한과 같은 3분 */
export const ARS_WATCH_TIMEOUT_MS = AUTH_TIMEOUT_MS
export interface ArsWatchDeps {
  adb: AdbRunner
  serials: () => string[]
  now: () => number
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  /** 수신을 처음 감지했을 때 한 번만 부른다 */
  onDetected: (serial: string) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

/**
 * 인증 대기 동안 3초마다 전화 수신을 살핀다. 감지되면 알리고 멈춘다 —
 * 받지도, 키패드를 누르지도 않는다(5단계 몫)
 */
export async function watchIncomingCall(deps: ArsWatchDeps): Promise<string | null> {
  const sleep = deps.sleep ?? defaultSleep
  const start = deps.now()
  while (deps.now() - start < ARS_WATCH_TIMEOUT_MS) {
    if (deps.cancelled?.()) return null
    const serial = await detectIncomingCall(deps.adb, deps.serials())
    if (serial) {
      deps.onDetected(serial)
      return serial
    }
    await sleep(ARS_POLL_INTERVAL_MS)
  }
  return null
}
