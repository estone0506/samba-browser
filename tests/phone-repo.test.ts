// 폰·인증 이벤트·계정 매핑 저장소 — 전부 동기화 제외 대상임을 함께 단언한다

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { PhoneRepo, defaultLabel, computeState } from '../src/main/phone/repo'
import { SYNC_TABLES } from '../src/shared/sync'

describe('PhoneRepo', () => {
  let db: Db
  let repo: PhoneRepo

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    repo = new PhoneRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  it('처음 보는 serial 에 기본 별칭과 country: KR 로 행을 만든다', () => {
    const row = repo.upsertSeen({
      serial: 'ABCD1234',
      model: '',
      transport: 'usb',
      state: 'online',
      at: 1000
    })
    expect(row.serial).toBe('ABCD1234')
    expect(row.label).toBe(defaultLabel('ABCD1234', ''))
    expect(row.label).toBe('폰 1234')
    expect(row.country).toBe('KR')

    const withModel = repo.upsertSeen({
      serial: 'ZZZZ9999',
      model: 'Galaxy S24',
      transport: 'usb',
      state: 'online',
      at: 1000
    })
    expect(withModel.label).toBe('Galaxy S24')
  })

  it('같은 serial 을 다시 보면 행이 늘지 않고 lastSeenAt·transport·model 만 갱신된다', () => {
    repo.upsertSeen({ serial: 'S1', model: '', transport: 'usb', state: 'online', at: 1000 })
    repo.setLabel(repo.list()[0].id, '내 폰', 'KR')

    const updated = repo.upsertSeen({
      serial: 'S1',
      model: 'Pixel 8',
      transport: 'wifi',
      state: 'online',
      at: 2000
    })

    expect(repo.list()).toHaveLength(1)
    expect(updated.lastSeenAt).toBe(2000)
    expect(updated.transport).toBe('wifi')
    expect(updated.model).toBe('Pixel 8')
    // 사용자가 정한 별칭은 재연결로 덮어쓰지 않는다
    expect(updated.label).toBe('내 폰')
  })

  it('markMissing 은 lastSeenAt 을 유지하고, 오래된 lastSeenAt 은 disconnected 로 계산된다', () => {
    repo.upsertSeen({ serial: 'S1', model: '', transport: 'usb', state: 'online', at: 1000 })
    repo.markMissing(['S1'], 20000)

    const row = repo.list()[0]
    expect(row.lastSeenAt).toBe(1000)
    expect(computeState(row.lastSeenAt, 20000)).toBe('disconnected')
    expect(computeState(row.lastSeenAt, 1500)).toBe('online')
  })

  it('setLabel·setSmsQueryOk·setWifiAddress 가 반영된다', () => {
    const row = repo.upsertSeen({
      serial: 'S1',
      model: '',
      transport: 'usb',
      state: 'online',
      at: 1000
    })
    repo.setLabel(row.id, '작업용', 'JP')
    repo.setSmsQueryOk(row.id, true)
    repo.setWifiAddress(row.id, '192.168.0.10:5555')

    const updated = repo.list()[0]
    expect(updated.label).toBe('작업용')
    expect(updated.country).toBe('JP')
    expect(updated.smsQueryOk).toBe(true)
    expect(updated.wifiAddress).toBe('192.168.0.10:5555')
  })

  it('assignAccount 로 계정 ↔ 폰을 연결하고 해제한다', () => {
    const phone = repo.upsertSeen({
      serial: 'S1',
      model: '',
      transport: 'usb',
      state: 'online',
      at: 1000
    })

    repo.assignAccount(1, phone.id)
    expect(repo.phoneForAccount(1)?.serial).toBe('S1')

    repo.assignAccount(1, null)
    expect(repo.phoneForAccount(1)).toBeNull()
  })

  it('recordAuthEvent 는 본문도 인증번호 평문도 저장하지 않는다(I20)', () => {
    repo.recordAuthEvent({
      jobId: 'job-1',
      phoneId: null,
      kind: 'sms',
      siteHost: 'example.com',
      ok: true,
      method: 'sms_query',
      elapsedMs: 1200,
      code: '123456',
      senderTail: '1234',
      at: 1000
    })

    const events = repo.listAuthEvents()
    expect(events).toHaveLength(1)
    // 평문은 남지 않고 자리수만 남는다
    expect(events[0].code).toBe('••••••')
    expect(events[0].code).not.toContain('1')
    expect(events[0].senderTail).toBe('1234')
    // 문자 본문(body)을 담는 컬럼이 있어서는 안 된다
    expect(Object.keys(events[0])).not.toContain('body')
  })

  it('purgeStoredCodes 는 예전에 평문으로 남은 인증번호를 자리수 표시로 바꾼다', () => {
    repo.recordAuthEvent({
      jobId: 'job-2',
      phoneId: null,
      kind: 'sms',
      siteHost: 'example.com',
      ok: true,
      method: 'sms_query',
      elapsedMs: 900,
      code: '654321',
      senderTail: '1234',
      at: 2000
    })
    // 저장 시점에 이미 가려지므로 더 지울 것이 없다
    expect(repo.purgeStoredCodes()).toBe(0)
    expect(repo.listAuthEvents()[0].code).not.toMatch(/[0-9]/)
  })

  it('unattendedRate 가 kind·기간별 total·ok 를 센다', () => {
    repo.recordAuthEvent({
      jobId: null,
      phoneId: null,
      kind: 'sms',
      siteHost: 'a.com',
      ok: true,
      method: 'sms_query',
      elapsedMs: 100,
      code: '1',
      senderTail: '1',
      at: 1000
    })
    repo.recordAuthEvent({
      jobId: null,
      phoneId: null,
      kind: 'sms',
      siteHost: 'a.com',
      ok: false,
      method: 'manual',
      elapsedMs: 100,
      code: null,
      senderTail: null,
      at: 2000
    })
    repo.recordAuthEvent({
      jobId: null,
      phoneId: null,
      kind: 'app_approve',
      siteHost: 'b.com',
      ok: true,
      method: 'visual',
      elapsedMs: 100,
      code: null,
      senderTail: null,
      at: 3000
    })

    expect(repo.unattendedRate('sms', 0)).toEqual({ total: 2, ok: 1 })
    expect(repo.unattendedRate('sms', 1500)).toEqual({ total: 1, ok: 0 })
    expect(repo.unattendedRate('app_approve', 0)).toEqual({ total: 1, ok: 1 })
  })

  it('phones·auth_events·account_phones 는 동기화 대상이 아니다', () => {
    const tables: readonly string[] = SYNC_TABLES
    expect(tables).not.toContain('phones')
    expect(tables).not.toContain('auth_events')
    expect(tables).not.toContain('account_phones')
  })
})
