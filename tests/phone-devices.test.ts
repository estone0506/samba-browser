import { describe, it, expect, beforeEach } from 'vitest'
import { DeviceManager, type DeviceRepo, type PhoneRowLike } from '../src/main/phone/devices'
import { DEVICE_POLL_INTERVAL_MS, PHONE_LIMIT, type PhoneDto } from '../src/shared/phone'
import { ADB_CANDIDATES } from '../src/main/phone/adb'
import { PhoneService, type PhoneServiceRepo } from '../src/main/phone/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { FakeAdb } from './stubs/fake-adb'

// 폴링을 실제 시간에 맡기지 않는다 — 테스트가 직접 tick() 으로 돌린다
class FakeTimer {
  private fns: (() => void)[] = []
  readonly setInterval = (fn: () => void, ms: number): unknown => {
    this.lastMs = ms
    this.fns.push(fn)
    return this.fns.length
  }
  readonly clearInterval = (handle: unknown): void => {
    this.fns.splice((handle as number) - 1, 1, () => {})
  }
  lastMs = 0
  tick(): void {
    for (const fn of [...this.fns]) fn()
  }
}

// 표 대신 메모리 배열을 쓰는 가짜 저장소(T2 의 PhoneRepo 와 같은 모양)
class FakeRepo implements DeviceRepo {
  readonly rows: PhoneRowLike[] = []
  private nextId = 1

  upsertSeen(input: {
    serial: string
    model: string
    transport: string
    state: string
    at: number
  }): PhoneRowLike {
    const found = this.rows.find((r) => r.serial === input.serial)
    if (found) {
      found.model = input.model || found.model
      found.transport = input.transport
      found.lastSeenAt = input.at
      return found
    }
    const row: PhoneRowLike = {
      id: this.nextId++,
      serial: input.serial,
      label: input.model || input.serial,
      country: 'KR',
      transport: input.transport,
      wifiAddress: input.transport === 'wifi' ? input.serial : null,
      model: input.model,
      smsQueryOk: null,
      lastSeenAt: input.at
    }
    this.rows.push(row)
    return row
  }

  list(): PhoneRowLike[] {
    return [...this.rows]
  }
}

const ONE = 'List of devices attached\nR3CRA05HY3R device usb:1-4 model:SM_A546S transport_id:3\n'
const NONE = 'List of devices attached\n'

interface Harness {
  adb: FakeAdb
  repo: FakeRepo
  timer: FakeTimer
  changes: { list: PhoneDto[]; warning?: string }[]
  manager: DeviceManager
}

function makeHarness(options: { autoReconnect?: boolean } = {}): Harness {
  const adb = new FakeAdb()
  const repo = new FakeRepo()
  const timer = new FakeTimer()
  const changes: { list: PhoneDto[]; warning?: string }[] = []
  const manager = new DeviceManager({
    adb,
    repo,
    now: () => 1_000,
    autoReconnect: () => options.autoReconnect !== false,
    onChange: (list, warning) => changes.push({ list, warning }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval
  })
  return { adb, repo, timer, changes, manager }
}

/** adb 호출 중 `devices` 조회만 센다 */
function deviceCalls(adb: FakeAdb): string[][] {
  return adb.calls.filter((c) => c[0] === 'devices')
}

describe('DeviceManager 폴링', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('start() 후 5초 주기로 devices -l 을 부른다', async () => {
    h.adb.reply('devices -l', ONE)
    h.manager.start()
    await Promise.resolve()
    expect(h.timer.lastMs).toBe(DEVICE_POLL_INTERVAL_MS)
    expect(deviceCalls(h.adb)).toHaveLength(1)
    h.timer.tick()
    h.timer.tick()
    await Promise.resolve()
    expect(deviceCalls(h.adb)).toHaveLength(3)
    h.manager.stop()
    h.timer.tick()
    expect(deviceCalls(h.adb)).toHaveLength(3)
  })

  it('새 폰이 보이면 저장하고 변경을 1회 통지한다', async () => {
    h.adb.reply('devices -l', ONE)
    const list = await h.manager.refresh()
    expect(list).toHaveLength(1)
    expect(list[0].serial).toBe('R3CRA05HY3R')
    expect(list[0].state).toBe('online')
    expect(h.repo.rows).toHaveLength(1)
    expect(h.changes).toHaveLength(1)
  })

  it('같은 목록이 반복되면 다시 통지하지 않는다', async () => {
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    await h.manager.refresh()
    await h.manager.refresh()
    expect(h.changes).toHaveLength(1)
    expect(h.manager.list()).toHaveLength(1)
  })

  it('목록에서 사라진 폰은 disconnected 로 바뀌며 통지한다', async () => {
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    const list = await h.manager.refresh()
    expect(list[0].state).toBe('disconnected')
    expect(h.changes).toHaveLength(2)
  })

  it('unauthorized 는 그대로 보고하고 자동 복구 대상이 아니다', async () => {
    h.adb.reply('devices -l', 'List of devices attached\nZY227FAKE9 unauthorized usb:1-6\n')
    const list = await h.manager.refresh()
    expect(list[0].state).toBe('unauthorized')
    expect(h.adb.calls.some((c) => c[0] === 'kill-server')).toBe(false)
  })
})

describe('DeviceManager 끊김 복구', () => {
  it('recover() 는 kill-server → start-server → devices 를 정확히 1회씩 부르고 재시도하지 않는다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', NONE)
    const ok = await h.manager.recover('R3CRA05HY3R')
    expect(ok).toBe(false)
    expect(h.adb.calls.map((c) => c.join(' '))).toEqual([
      'kill-server',
      'start-server',
      'devices -l'
    ])
  })

  it('복구 후 폰이 보이면 true 를 돌려준다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', ONE)
    expect(await h.manager.recover('R3CRA05HY3R')).toBe(true)
  })

  it('자동 복구는 끊긴 폰마다 1회만 시도한다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    await h.manager.refresh()
    await h.manager.refresh()
    await h.manager.refresh()
    expect(h.adb.calls.filter((c) => c[0] === 'kill-server')).toHaveLength(1)
  })

  it('autoReconnect() 가 false 면 끊겨도 자동 복구하지 않는다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    await h.manager.refresh()
    expect(h.adb.calls.some((c) => c[0] === 'kill-server')).toBe(false)
  })
})

describe('DeviceManager 상한과 와이파이', () => {
  it('동시 연결 상한을 넘는 폰은 offline 으로 두고 경고를 함께 통지한다', async () => {
    const h = makeHarness()
    const lines = ['List of devices attached']
    for (let i = 0; i < PHONE_LIMIT + 1; i++) {
      lines.push(`SERIAL${i} device usb:1-${i} model:SM_A54${i}`)
    }
    h.adb.reply('devices -l', `${lines.join('\n')}\n`)
    const list = await h.manager.refresh()
    expect(list).toHaveLength(PHONE_LIMIT + 1)
    expect(list.slice(0, PHONE_LIMIT).every((p) => p.state === 'online')).toBe(true)
    expect(list[PHONE_LIMIT].state).toBe('offline')
    expect(h.changes[0].warning).toBeTruthy()
  })

  it('connectWifi 는 포트를 생략하면 5555 를 붙인다', async () => {
    const h = makeHarness()
    h.adb.reply('connect', 'connected to 192.168.0.5:5555')
    h.adb.reply('devices -l', NONE)
    const res = await h.manager.connectWifi('192.168.0.5')
    expect(res.ok).toBe(true)
    expect(h.adb.calls[0]).toEqual(['connect', '192.168.0.5:5555'])
  })

  it('connectWifi 는 이미 포트가 있으면 그대로 쓴다', async () => {
    const h = makeHarness()
    h.adb.reply('connect', 'failed to connect to 192.168.0.5:5037')
    const res = await h.manager.connectWifi('192.168.0.5:5037')
    expect(res.ok).toBe(false)
    expect(h.adb.calls[0]).toEqual(['connect', '192.168.0.5:5037'])
  })

  it('disconnect 는 serial 로 끊고 목록을 다시 읽는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', NONE)
    await h.manager.disconnect('192.168.0.5:5555')
    expect(h.adb.calls[0]).toEqual(['disconnect', '192.168.0.5:5555'])
    expect(deviceCalls(h.adb)).toHaveLength(1)
  })
})

// --- PhoneService ----------------------------------------------------------
// 경로 탐지 테스트에서 "있다"고 답할 단 하나의 후보
const ADB_FOUND = ADB_CANDIDATES[0]

class FakeServiceRepo extends FakeRepo implements PhoneServiceRepo {
  readonly assigned: [number, number | null][] = []
  readonly smsFlags: [number, boolean][] = []

  setLabel(id: number, label: string, country: string): void {
    const row = this.rows.find((r) => r.id === id)
    if (row) {
      row.label = label
      row.country = country
    }
  }
  setSmsQueryOk(id: number, ok: boolean): void {
    this.smsFlags.push([id, ok])
    const row = this.rows.find((r) => r.id === id)
    if (row) row.smsQueryOk = ok
  }
  assignAccount(accountId: number, phoneId: number | null): void {
    this.assigned.push([accountId, phoneId])
  }
  phoneForAccount(accountId: number): PhoneRowLike | null {
    const found = this.assigned.filter(([a]) => a === accountId).pop()
    if (!found || found[1] === null) return null
    return this.rows.find((r) => r.id === found[1]) ?? null
  }
  listAuthEvents(): [] {
    return []
  }
}

function makeService(): {
  adb: FakeAdb
  repo: FakeServiceRepo
  emitted: { list: PhoneDto[]; warning?: string }[]
  settings: Settings
  service: PhoneService
} {
  const adb = new FakeAdb()
  const repo = new FakeServiceRepo()
  const emitted: { list: PhoneDto[]; warning?: string }[] = []
  let settings: Settings = { ...DEFAULT_SETTINGS }
  const service = new PhoneService({
    adb,
    repo,
    settings: {
      get: () => settings,
      set: (patch) => {
        settings = { ...settings, ...patch }
        return settings
      }
    },
    emit: (list, warning) => emitted.push({ list, warning }),
    emitAuthWaiting: () => {},
    now: () => 1_000,
    exists: (p) => p === ADB_FOUND
  })
  return {
    adb,
    repo,
    emitted,
    get settings() {
      return settings
    },
    service
  }
}

describe('PhoneService', () => {
  it('detectPaths 는 찾은 경로로 비어 있는 설정을 채운다', () => {
    const s = makeService()
    const found = s.service.detectPaths()
    expect(found.adb).toBe(ADB_FOUND)
    expect(found.scrcpy).toBe('')
    expect(s.settings.adbPath).toBe(ADB_FOUND)
  })

  it('폰이 붙으면 문자 DB 시험 조회를 폰당 1회만 한다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    s.adb.reply('content query', 'Row: 0 _id=1')
    await s.service.refresh()
    await s.service.refresh()
    const probes = s.adb.calls.filter((c) => c.includes('content'))
    expect(probes).toHaveLength(1)
    expect(s.repo.smsFlags).toEqual([[1, true]])
  })

  it('권한이 없으면 문자 DB 조회 불가로 기록한다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    s.adb.reply('content query', 'Error: Permission Denial: reading SmsProvider')
    await s.service.refresh()
    expect(s.repo.smsFlags).toEqual([[1, false]])
  })

  it('assignForJob 은 매핑된 폰을 돌려주고 없으면 null 이다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    await s.service.refresh()
    expect(s.service.assignForJob(7)).toBeNull()
    s.service.assign(7, 1)
    expect(s.service.assignForJob(7)?.serial).toBe('R3CRA05HY3R')
  })

  it('setLabel 은 나라 값이 이상하면 KR 로 되돌린다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    await s.service.refresh()
    s.service.setLabel(1, '업무용', 'XX')
    expect(s.repo.rows[0]).toMatchObject({ label: '업무용', country: 'KR' })
  })
})
