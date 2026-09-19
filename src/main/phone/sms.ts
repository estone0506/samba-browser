// 문자 인증번호 추출. 본문은 절대 이 파일 밖으로 내보내지 않는다 —
// 여기가 돌려주는 것은 숫자 코드와 발신번호 뒷 4자리뿐이다(스펙 "안전" 절).
// 파싱·추출·점수는 전부 순수 함수라 폰 없이 테스트한다

import { AUTH_TIMEOUT_MS, SMS_POLL_INTERVAL_MS, SMS_RECENT_MS } from '../../shared/phone'
import { shellArgs } from './adb'
import type { AdbResult, AdbRunner } from './process'

export interface SmsRow {
  address: string
  body: string
  dateMs: number
}

export interface SmsCandidate {
  code: string
  senderTail: string
  score: number
  dateMs: number
}

// content query 한 줄: `Row: 0 _id=12, address=15881234, body=..., date=1758200000000`
const ROW_RE = /^Row:\s*\d+\s+(.*)$/
const DENIED_RE = /Permission Denial|SecurityException/i
// 4~8자리 숫자. 앞뒤가 숫자거나 하이픈이면(전화번호·날짜) 후보에서 뺀다
const CODE_RE = /(?<![\d-])(\d{4,8})(?![\d-])/g
// 인증 문맥 단어
const CONTEXT_RE = /인증(번호)?|확인번호|verification|one[- ]?time|OTP|code/i
// 금액으로 보이는 숫자(원·₩ 인접)는 제외
const MONEY_RE = /₩|원/
// 주문번호·운송장번호 등 인증과 무관한 번호는 제외
const SERIAL_NO_RE = /(주문|운송장|송장|계좌|회원|고객)\s*번호\s*[:=]?\s*$/

export const SMS_QUERY_ARGS = [
  'content',
  'query',
  '--uri',
  'content://sms/inbox',
  '--projection',
  '_id:address:body:date',
  '--sort',
  'date DESC'
]

// 삼성처럼 문자 DB 조회가 막힌 폰에서 쓰는 1차 폴백 — 알림 로그를 읽는다
export const NOTIFICATION_DUMP_ARGS = ['dumpsys', 'notification', '--noredact']

// 문자 앱으로 인정하는 패키지 조각(카카오톡 등 메신저 알림은 읽지 않는다)
export const SMS_PACKAGE_HINTS = ['messaging', 'mms', 'sms']

/** 조회가 권한 등으로 막혔는가(내용이 비었을 뿐인 정상 응답과 구분한다) */
export function isQueryBlocked(res: AdbResult): boolean {
  return res.code !== 0 || DENIED_RE.test(res.stdout) || DENIED_RE.test(res.stderr)
}

export function parseSmsQuery(stdout: string): SmsRow[] {
  if (DENIED_RE.test(stdout)) return []
  const rows: SmsRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = ROW_RE.exec(line.trim())
    if (!m) continue
    const fields = m[1]
    const address = /(?:^|,\s)address=(.*?)(?=,\s\w+=|$)/.exec(fields)?.[1]?.trim() ?? ''
    // body 는 쉼표를 품을 수 있어 "다음 필드 이름 앞" 까지를 잡는다
    const body = /(?:^|,\s)body=([\s\S]*?)(?=,\s(?:date|_id|address)=|$)/.exec(fields)?.[1] ?? ''
    const dateMs = Number(/(?:^|,\s)date=(\d+)/.exec(fields)?.[1] ?? '0')
    if (!body) continue
    rows.push({ address, body, dateMs })
  }
  return rows
}

/** `dumpsys notification` 출력에서 문자 앱 알림만 뽑는다(문자 DB 가 막힌 폰용 폴백) */
export function parseNotificationSms(stdout: string): SmsRow[] {
  const rows: SmsRow[] = []
  for (const chunk of stdout.split(/NotificationRecord\(/).slice(1)) {
    const pkg = /pkg=(\S+)/.exec(chunk)?.[1] ?? ''
    if (!SMS_PACKAGE_HINTS.some((hint) => pkg.toLowerCase().includes(hint))) continue
    const body = extraValue(chunk, 'text')
    if (!body) continue
    rows.push({
      address: extraValue(chunk, 'title'),
      body,
      dateMs: Number(/m?When=(\d+)/.exec(chunk)?.[1] ?? '0')
    })
  }
  return rows
}

/** `android.text=String (본문)` 꼴에서 값만 꺼낸다 */
function extraValue(chunk: string, key: string): string {
  const line = new RegExp(`android\\.${key}=([^\\n]*)`).exec(chunk)?.[1]?.trim() ?? ''
  return (/^\w*\s*\((.*)\)$/.exec(line)?.[1] ?? line).trim()
}

export function extractCodes(body: string): string[] {
  const out: string[] = []
  CODE_RE.lastIndex = 0
  let m = CODE_RE.exec(body)
  while (m) {
    const around = body.slice(Math.max(0, m.index - 2), m.index + m[1].length + 2)
    const before = body.slice(Math.max(0, m.index - 14), m.index)
    if (!MONEY_RE.test(around) && !SERIAL_NO_RE.test(before)) out.push(m[1])
    m = CODE_RE.exec(body)
  }
  return out
}

/** 사이트 브랜드 토큰 — host 의 첫 라벨(예: toss.im → toss) */
export function brandToken(siteHost: string): string {
  const labels = siteHost.split('.').filter((l) => l && l !== 'www' && l !== 'm')
  return labels[0] ?? ''
}

export function scoreRow(row: SmsRow, ctx: { now: number; siteHost: string }): SmsCandidate | null {
  if (ctx.now - row.dateMs > SMS_RECENT_MS) return null
  const codes = extractCodes(row.body)
  if (codes.length === 0) return null
  let score = 1
  if (CONTEXT_RE.test(row.body)) score += 2
  const brand = brandToken(ctx.siteHost)
  if (brand && row.body.toLowerCase().includes(brand.toLowerCase())) score += 3
  // 6자리는 인증번호로 가장 흔하다
  const code = codes.find((c) => c.length === 6) ?? codes[0]
  if (code.length === 6) score += 1
  return { code, senderTail: row.address.slice(-4), score, dateMs: row.dateMs }
}

export function pickAuthCode(
  rows: SmsRow[],
  ctx: { now: number; siteHost: string }
): SmsCandidate | null {
  const candidates = rows
    .map((r) => scoreRow(r, ctx))
    .filter((c): c is SmsCandidate => c !== null)
    // 점수가 같으면 더 최근 문자를 고른다
    .sort((a, b) => b.score - a.score || b.dateMs - a.dateMs)
  return candidates[0] ?? null
}

export interface SmsWatchDeps {
  adb: AdbRunner
  serials: () => string[]
  siteHost: string
  now: () => number
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  /** 문자함·알림 로그가 모두 막힌 폰의 마지막 수단(화면 읽기). Task 9 가 Visual 을 꽂는다 */
  screenFallback?: (serial: string) => Promise<SmsCandidate | null>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

// 한 폰에서 문자 목록을 읽는다. 문자함 → 알림 로그 순으로 시도한다
async function readRows(
  deps: SmsWatchDeps,
  serial: string
): Promise<{ rows: SmsRow[]; blocked: boolean }> {
  const res = await deps.adb.run(shellArgs(serial, SMS_QUERY_ARGS), 8000)
  if (!isQueryBlocked(res)) return { rows: parseSmsQuery(res.stdout), blocked: false }
  const dump = await deps.adb.run(shellArgs(serial, NOTIFICATION_DUMP_ARGS), 8000)
  if (isQueryBlocked(dump)) return { rows: [], blocked: true }
  return { rows: parseNotificationSms(dump.stdout), blocked: false }
}

/** 3대를 1초 주기로 동시에 보고 먼저 온 인증번호를 돌려준다. 3분이면 null */
export async function watchSms(
  deps: SmsWatchDeps
): Promise<(SmsCandidate & { serial: string }) | null> {
  const sleep = deps.sleep ?? defaultSleep
  const start = deps.now()
  while (deps.now() - start < AUTH_TIMEOUT_MS) {
    if (deps.cancelled?.()) return null
    for (const serial of deps.serials()) {
      const { rows, blocked } = await readRows(deps, serial)
      if (blocked) {
        const seen = await deps.screenFallback?.(serial)
        if (seen) return { ...seen, serial }
        continue
      }
      // 감시 시작보다 한참 이전 문자는 무시한다(지난 인증번호 재사용 방지)
      const fresh = rows.filter((r) => r.dateMs >= start - SMS_RECENT_MS)
      const picked = pickAuthCode(fresh, { now: deps.now(), siteHost: deps.siteHost })
      if (picked) return { ...picked, serial }
    }
    await sleep(SMS_POLL_INTERVAL_MS)
  }
  return null
}
