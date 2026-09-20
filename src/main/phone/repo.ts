// 폰 · 인증 이벤트 · 계정-폰 매핑 저장소. 전부 PC 로컬 전용이라 동기화하지 않는다
// (SYNC_TABLES 에 넣지 않는다 — tests/phone-repo.test.ts 에서 단언).
//
// 비밀값 방어: auth_events 는 문자 본문도 인증번호도 담지 않는다 — 발신번호 뒷 4자리
// (senderTail)와 지표에 필요한 값만 남긴다. 인증번호는 화면에 채우는 그 순간에만
// 메모리에 있고, 저장할 때는 자리수만 남기고 버린다(I20)

import { and, desc, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { accountPhones, authEvents, phones } from '../db/schema'
import type {
  AuthEventDto,
  AuthEventKind,
  PhoneCountry,
  PhoneState,
  PhoneTransport
} from '../../shared/phone'

/** 연결이 끊겼다고 볼 때까지의 여유 시간(폴링 주기의 2배) */
const DISCONNECTED_AFTER_MS = 10_000

const DEFAULT_LIST_LIMIT = 200

export interface PhoneRow {
  id: number
  serial: string
  label: string
  country: PhoneCountry
  transport: PhoneTransport
  wifiAddress: string | null
  model: string
  smsQueryOk: boolean | null
  lastSeenAt: number
  workspaceId: number | null
}

export interface UpsertSeenInput {
  serial: string
  model: string
  transport: PhoneTransport
  // adb 가 지금 보고하는 상태. 저장소는 이 값을 컬럼에 담지 않는다(상태는 폴링 결과로
  // 그때그때 덮어쓴다) — 인터페이스 일관성을 위해 받기만 한다
  state: PhoneState
  at: number
}

/**
 * 인증번호를 자리수만 남긴 표시로 바꾼다(`123456` → `••••••`).
 * 지표(무인 처리율·자리수)는 이 값으로 충분하고, 평문은 디스크에 남지 않는다
 */
export function maskCode(code: string | null | undefined): string | null {
  if (!code) return null
  return '\u2022'.repeat(code.length)
}

/** 처음 본 폰의 기본 별칭 — 모델명이 있으면 모델명, 없으면 serial 뒤 4자리 */
export function defaultLabel(serial: string, model: string): string {
  return model.trim() || `폰 ${serial.slice(-4)}`
}

/**
 * lastSeenAt 만으로 상태를 어림잡는다. 실제 연결 여부는 서비스 계층이 살아있는
 * adb 폴링 결과로 덮어쓰므로, 여기서는 "오래 못 봤으면 disconnected" 정도만 판단한다
 */
export function computeState(lastSeenAt: number, now: number): PhoneState {
  return now - lastSeenAt > DISCONNECTED_AFTER_MS ? 'disconnected' : 'online'
}

export class PhoneRepo {
  constructor(private readonly db: Db) {}

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  // --- 폰 -------------------------------------------------------------------

  /** 폰을 보면 호출한다 — 처음이면 행을 만들고, 이미 있으면 lastSeenAt·transport·model 만 갱신한다 */
  upsertSeen(input: UpsertSeenInput): PhoneRow {
    const existing = this.d.select().from(phones).where(eq(phones.serial, input.serial)).get()

    if (!existing) {
      const inserted = this.d
        .insert(phones)
        .values({
          serial: input.serial,
          label: defaultLabel(input.serial, input.model),
          country: 'KR',
          transport: input.transport,
          model: input.model,
          lastSeenAt: input.at
        })
        .returning()
        .all()
      this.db.scheduleSave()
      return toPhoneRow(inserted[0])
    }

    this.d
      .update(phones)
      .set({ transport: input.transport, model: input.model, lastSeenAt: input.at })
      .where(eq(phones.id, existing.id))
      .run()
    this.db.scheduleSave()
    return toPhoneRow({
      ...existing,
      transport: input.transport,
      model: input.model,
      lastSeenAt: input.at
    })
  }

  list(): PhoneRow[] {
    return this.d.select().from(phones).all().map(toPhoneRow)
  }

  setLabel(id: number, label: string, country: PhoneCountry): void {
    this.d.update(phones).set({ label, country }).where(eq(phones.id, id)).run()
    this.db.scheduleSave()
  }

  setSmsQueryOk(id: number, ok: boolean): void {
    this.d.update(phones).set({ smsQueryOk: ok }).where(eq(phones.id, id)).run()
    this.db.scheduleSave()
  }

  setWifiAddress(id: number, address: string | null): void {
    this.d.update(phones).set({ wifiAddress: address }).where(eq(phones.id, id)).run()
    this.db.scheduleSave()
  }

  /**
   * 이번 폴링에서 안 보인 serial 들을 표시한다. lastSeenAt 은 건드리지 않는다 —
   * 그래야 마지막으로 본 시각을 기준으로 disconnected 여부를 나중에 판단할 수 있다
   */
  markMissing(serials: string[], _at: number): void {
    // 저장소는 lastSeenAt 만 다루고, 안 보인 serial 은 그냥 갱신하지 않는 것으로 표시한다
    void serials
    void _at
  }

  // --- 계정 ↔ 폰 매핑 ---------------------------------------------------------

  assignAccount(accountId: number, phoneId: number | null): void {
    if (phoneId === null) {
      this.d.delete(accountPhones).where(eq(accountPhones.accountId, accountId)).run()
      this.db.scheduleSave()
      return
    }
    const now = Date.now()
    this.d
      .insert(accountPhones)
      .values({ accountId, phoneId, updatedAt: now })
      .onConflictDoUpdate({ target: accountPhones.accountId, set: { phoneId, updatedAt: now } })
      .run()
    this.db.scheduleSave()
  }

  phoneForAccount(accountId: number): PhoneRow | null {
    const mapping = this.d
      .select()
      .from(accountPhones)
      .where(eq(accountPhones.accountId, accountId))
      .get()
    if (!mapping) return null
    const phone = this.d.select().from(phones).where(eq(phones.id, mapping.phoneId)).get()
    return phone ? toPhoneRow(phone) : null
  }

  // --- 인증 이벤트 ------------------------------------------------------------

  /**
   * 문자 본문은 받지 않는다. 인증번호(code)도 디스크에 남기지 않는다 —
   * 지표에 필요한 것은 "몇 자리였나" 뿐이라 자리수만 별표로 바꿔 저장한다.
   * (예전 버전이 남긴 평문은 purgeStoredCodes 가 지운다)
   */
  recordAuthEvent(input: Omit<AuthEventDto, 'id'>): void {
    this.d
      .insert(authEvents)
      .values({
        jobId: input.jobId,
        phoneId: input.phoneId,
        kind: input.kind,
        siteHost: input.siteHost,
        ok: input.ok,
        method: input.method,
        elapsedMs: input.elapsedMs,
        code: maskCode(input.code),
        senderTail: input.senderTail,
        payMethod: input.payMethod ?? null,
        at: input.at
      })
      .run()
    this.db.scheduleSave()
  }

  /**
   * 이 (사이트 × 결제수단) 조합으로 성공한 결제 승인이 이미 있는가.
   * 없으면 "첫 결제" 로 보고 소액 상한(FIRST_RUN_LIMIT_KRW)을 건다
   */
  hasPayApproval(siteHost: string, payMethod: string): boolean {
    const row = this.d
      .select({ id: authEvents.id })
      .from(authEvents)
      .where(
        and(
          eq(authEvents.kind, 'app_approve'),
          eq(authEvents.ok, true),
          eq(authEvents.siteHost, siteHost),
          eq(authEvents.payMethod, payMethod)
        )
      )
      .get()
    return row !== undefined
  }

  /** 예전 버전이 평문으로 남긴 인증번호를 자리수 표시로 바꾼다(앱 시작 때 한 번) */
  purgeStoredCodes(): number {
    const rows = this.d.select({ id: authEvents.id, code: authEvents.code }).from(authEvents).all()
    let changed = 0
    for (const row of rows) {
      if (!row.code || !/[0-9]/.test(row.code)) continue
      this.d
        .update(authEvents)
        .set({ code: maskCode(row.code) })
        .where(eq(authEvents.id, row.id))
        .run()
      changed += 1
    }
    if (changed > 0) this.db.scheduleSave()
    return changed
  }

  listAuthEvents(limit: number = DEFAULT_LIST_LIMIT): AuthEventDto[] {
    return this.d
      .select()
      .from(authEvents)
      .orderBy(desc(authEvents.at))
      .limit(Math.max(1, limit))
      .all()
      .map(toAuthEventDto)
  }

  /** 무인 처리율 = ok 인 건 / 전체 건 */
  unattendedRate(kind: AuthEventKind, sinceMs: number): { total: number; ok: number } {
    const rows = this.d
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.kind, kind), gte(authEvents.at, sinceMs)))
      .all()
    const total = rows.length
    const ok = rows.filter((row) => row.ok).length
    return { total, ok }
  }
}

function toPhoneRow(row: typeof phones.$inferSelect): PhoneRow {
  return {
    id: row.id,
    serial: row.serial,
    label: row.label,
    country: row.country as PhoneCountry,
    transport: row.transport as PhoneTransport,
    wifiAddress: row.wifiAddress,
    model: row.model,
    smsQueryOk: row.smsQueryOk,
    lastSeenAt: row.lastSeenAt,
    workspaceId: row.workspaceId
  }
}

function toAuthEventDto(row: typeof authEvents.$inferSelect): AuthEventDto {
  return {
    id: row.id,
    jobId: row.jobId,
    phoneId: row.phoneId,
    kind: row.kind as AuthEventKind,
    siteHost: row.siteHost,
    ok: row.ok,
    method: row.method as AuthEventDto['method'],
    elapsedMs: row.elapsedMs,
    code: row.code,
    senderTail: row.senderTail,
    payMethod: row.payMethod,
    at: row.at
  }
}
