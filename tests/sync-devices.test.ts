// 기기 등록·목록·원격 로그아웃. 네트워크 없이 가짜 백엔드로만 검증한다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { DeviceService, DEVICE_ID_KEY, DEVICES_TABLE } from '../src/main/sync/devices'
import { SyncLocal } from '../src/main/sync/local'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'

const OTHER_DEVICE = '00000000-0000-4000-8000-00000000dev2'

function makeService(db: Db, backend: FakeBackend): DeviceService {
  return new DeviceService({
    backend,
    db,
    userId: FAKE_USER_ID,
    hostname: () => '내-PC',
    osLabel: () => 'Windows_NT 10.0.26200',
    appVersion: () => '0.1.0'
  })
}

describe('DeviceService', () => {
  let db: Db
  let backend: FakeBackend
  let devices: DeviceService

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'))
    db = await openDatabase(':memory:')
    backend = createFakeBackend()
    devices = makeService(db, backend)
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('두 번 등록해도 기기 행은 하나이고 id 가 그대로다', async () => {
    const first = await devices.ensureRegistered()
    const second = await devices.ensureRegistered()

    expect(second).toBe(first)
    expect(backend.rows(DEVICES_TABLE)).toHaveLength(1)
    expect(new SyncLocal(db).getState(DEVICE_ID_KEY)).toBe(first)
    // 등록 행에는 사람이 읽을 이름·OS·버전만 들어간다(토큰·비밀값 없음)
    expect(backend.rows(DEVICES_TABLE)[0]).toMatchObject({
      user_id: FAKE_USER_ID,
      name: '내-PC',
      os: 'Windows_NT 10.0.26200',
      app_version: '0.1.0',
      revoked_at: null
    })
  })

  it('목록에서 이 PC 만 isCurrent 다', async () => {
    const mine = await devices.ensureRegistered()
    backend.seed(DEVICES_TABLE, [
      {
        id: OTHER_DEVICE,
        user_id: FAKE_USER_ID,
        name: '사무실-PC',
        os: 'Windows_NT 10.0.22631',
        app_version: '0.1.0',
        last_seen_at: new Date('2026-09-18T00:00:00.000Z').toISOString(),
        revoked_at: null
      }
    ])

    const list = await devices.list()

    expect(list).toHaveLength(2)
    expect(list.filter((d) => d.isCurrent)).toHaveLength(1)
    expect(list.find((d) => d.isCurrent)?.id).toBe(mine)
    // 최근에 본 기기가 위로 온다
    expect(list[0].id).toBe(mine)
  })

  it('다른 기기를 취소하면 그 행에 revoked_at 이 찍힌다', async () => {
    await devices.ensureRegistered()
    backend.seed(DEVICES_TABLE, [
      {
        id: OTHER_DEVICE,
        user_id: FAKE_USER_ID,
        name: '사무실-PC',
        os: 'Windows_NT 10.0.22631',
        app_version: '0.1.0',
        last_seen_at: new Date('2026-09-18T00:00:00.000Z').toISOString(),
        revoked_at: null
      }
    ])

    await devices.revoke(OTHER_DEVICE)

    const row = backend.rows(DEVICES_TABLE).find((r) => r.id === OTHER_DEVICE)
    expect(row?.revoked_at).not.toBeNull()
    // 내 기기는 그대로다
    expect(await devices.isRevoked()).toBe(false)
  })

  it('내 기기를 취소하면 isRevoked() 가 true 다', async () => {
    const mine = await devices.ensureRegistered()

    await devices.revoke(mine)

    expect(await devices.isRevoked()).toBe(true)
    // heartbeat 는 취소 표식을 지우지 않는다
    await devices.heartbeat()
    expect(await devices.isRevoked()).toBe(true)
  })

  it('list() 는 취소 표식을 되살리지 않는다', async () => {
    // ensureRegistered 는 revoked_at 을 null 로 덮는다 — 목록을 여는 것만으로
    // 원격 로그아웃이 풀리면 안 된다
    const mine = await devices.ensureRegistered()
    await devices.revoke(mine)

    const list = await devices.list()

    expect(await devices.isRevoked()).toBe(true)
    expect(list.find((d) => d.id === mine)?.revokedAt).not.toBeNull()
  })

  it('아직 등록 전이면 list() 가 기기를 새로 만들지 않는다', async () => {
    backend.seed(DEVICES_TABLE, [
      {
        id: OTHER_DEVICE,
        user_id: FAKE_USER_ID,
        name: '사무실-PC',
        os: 'Windows_NT 10.0.22631',
        app_version: '0.1.0',
        last_seen_at: new Date('2026-09-18T00:00:00.000Z').toISOString(),
        revoked_at: null
      }
    ])

    const list = await devices.list()

    expect(list).toHaveLength(1)
    expect(list[0].isCurrent).toBe(false)
    expect(new SyncLocal(db).getState(DEVICE_ID_KEY)).toBeNull()
  })

  it('heartbeat() 가 last_seen_at 을 갱신한다', async () => {
    await devices.ensureRegistered()
    const before = String(backend.rows(DEVICES_TABLE)[0].last_seen_at)

    vi.advanceTimersByTime(60_000)
    await devices.heartbeat()

    const after = String(backend.rows(DEVICES_TABLE)[0].last_seen_at)
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before))
    expect(backend.rows(DEVICES_TABLE)).toHaveLength(1)
  })
})
