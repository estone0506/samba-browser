// 기기 감시. adb 는 장치 이벤트 API 가 없어 5초 폴링으로 본다(PRD 04 배치표).
// 복구는 정확히 1회만 — 무한 재시도는 adb 서버를 더 망가뜨린다

import {
  DEVICE_POLL_INTERVAL_MS,
  PHONE_LIMIT,
  isPhoneCountry,
  type PhoneDto,
  type PhoneState,
  type PhoneTransport
} from '../../shared/phone'
import {
  isWifiSerial,
  parseDevices,
  parseMdnsServices,
  type AdbRunner,
  type MdnsService,
  type RawDevice
} from './adb'
import { tr } from '../i18n'

const WIFI_DEFAULT_PORT = 5555
/** 무선 디버깅 페어링 코드 자리수 */
const PAIR_CODE_LENGTH = 6
/** 발견된 와이파이 접속점에 다시 connect 를 시도하기까지 쉬는 시간 */
const WIFI_CONNECT_COOLDOWN_MS = 30_000

/**
 * 저장소가 돌려주는 폰 한 줄. 표 정의는 `phone/repo.ts`(Task 2) 에 있고
 * 여기서는 **구조적으로만** 받는다 — 서로 파일을 import 하지 않아 순서에 얽매이지 않는다.
 * 문자열 칸(country·transport)은 표에서 온 값이라 좁히지 않고 받아서 이 파일에서 판별한다
 */
export interface PhoneRowLike {
  id: number
  serial: string
  label: string
  country: string
  transport: string
  wifiAddress: string | null
  model: string
  smsQueryOk: boolean | null
  lastSeenAt: number
}

export interface DeviceRepo {
  upsertSeen: (input: {
    serial: string
    model: string
    transport: PhoneTransport
    state: PhoneState
    at: number
  }) => PhoneRowLike
  list: () => PhoneRowLike[]
}

export interface DeviceManagerDeps {
  adb: AdbRunner
  repo: DeviceRepo
  now: () => number
  autoReconnect: () => boolean
  // 경고 문구는 상한 초과처럼 사용자가 알아야 할 때만 함께 온다
  onChange: (phones: PhoneDto[], warning?: string) => void
  /**
   * 지금 설정된 adb 실행 파일 경로. 비어 있으면 adb 를 아예 부르지 않는다 —
   * AdbRunner 는 경로가 없으면 던지므로, 5초 폴링이 그대로 unhandledRejection 이 된다
   */
  adbPath?: () => string
  // 테스트에서 가짜 타이머를 넣는다
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/** 표의 문자열 칸을 공용 타입으로 좁힌다(손상된 값은 기본값으로 본다) */
function toTransport(value: string, serial: string): PhoneTransport {
  if (value === 'usb' || value === 'wifi') return value
  return isWifiSerial(serial) ? 'wifi' : 'usb'
}

function toDto(row: PhoneRowLike, live: RawDevice | undefined, overLimit: boolean): PhoneDto {
  // 상한을 넘은 폰은 붙어 있어도 쓰지 않는다는 뜻으로 offline 으로 둔다
  const state: PhoneState = overLimit ? 'offline' : (live?.state ?? 'disconnected')
  return {
    id: row.id,
    serial: row.serial,
    label: row.label || row.model || row.serial,
    country: isPhoneCountry(row.country) ? row.country : 'KR',
    transport: toTransport(live?.transport ?? row.transport, row.serial),
    wifiAddress: row.wifiAddress,
    model: live?.model || row.model,
    state,
    smsQueryOk: row.smsQueryOk,
    lastSeenAt: row.lastSeenAt,
    // 화면 전송 상태는 ScreenStream(Task 5) 이 따로 관리한다
    screenMode: null
  }
}

export class DeviceManager {
  private handle: unknown = null
  private phones: PhoneDto[] = []
  private lastHash = ''
  // 이번 연결 주기에 이미 복구를 시도한 serial(끊겼다 붙으면 비운다)
  private recovered = new Set<string>()
  // 발견된 와이파이 접속점(ip:port) → 다음 connect 시도 시각
  private wifiRetryAt = new Map<string, number>()

  constructor(private deps: DeviceManagerDeps) {}

  start(): void {
    if (this.handle !== null) return
    const setI =
      this.deps.setInterval ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
    void this.refresh()
    this.handle = setI(() => void this.refresh(), DEVICE_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.handle === null) return
    const clearI =
      this.deps.clearInterval ?? ((h: unknown): void => clearInterval(h as NodeJS.Timeout))
    clearI(this.handle)
    this.handle = null
  }

  list(): PhoneDto[] {
    return this.phones
  }

  /** adb 경로가 설정돼 있는가(경로 함수를 주지 않았으면 있다고 본다) */
  private hasAdb(): boolean {
    return this.deps.adbPath === undefined || this.deps.adbPath() !== ''
  }

  /**
   * 1회 즉시 스캔(설정 화면의 "지금 찾기").
   * adb 가 없거나 실행이 실패해도 던지지 않는다 — 5초 폴링에서 던지면
   * 붙잡는 곳이 없어 unhandledRejection 이 된다. 실패하면 직전 목록을 그대로 둔다
   */
  async refresh(): Promise<PhoneDto[]> {
    try {
      return await this.scan()
    } catch {
      // 도구가 없거나 adb 서버가 죽은 상황 — 조용히 직전 목록을 유지한다
      return this.phones
    }
  }

  private async scan(): Promise<PhoneDto[]> {
    // 경로가 비어 있으면 adb 를 부르지 않는다(부르면 곧바로 던진다)
    if (!this.hasAdb()) return this.phones
    const first = await this.deps.adb.run(['devices', '-l'])
    // 같은 와이파이에서 발견된 폰은 주소를 몰라도 알아서 붙인다. 새로 붙인 게 있으면 목록을 다시 읽는다
    const connected = await this.connectDiscovered(parseDevices(first.stdout))
    const res = connected ? await this.deps.adb.run(['devices', '-l']) : first
    const raw = parseDevices(res.stdout)
    const now = this.deps.now()
    for (const d of raw) {
      this.deps.repo.upsertSeen({
        serial: d.serial,
        model: d.model,
        transport: d.transport,
        state: d.state,
        at: now
      })
      // 다시 붙었으면 다음에 끊길 때 또 한 번 복구할 수 있게 표시를 지운다
      if (d.state === 'online') this.recovered.delete(d.serial)
    }
    // 저장된 폰 중 이번에 안 보인 것은 끊김으로 본다
    const rows = this.deps.repo.list()
    const next = rows.map((row, index) =>
      toDto(
        row,
        raw.find((d) => d.serial === row.serial),
        index >= PHONE_LIMIT
      )
    )
    const over = next.length - PHONE_LIMIT
    const warning = over > 0 ? tr('phone.overLimit', { limit: PHONE_LIMIT, over }) : undefined
    // 끊긴 폰 자동 복구 1회
    if (this.deps.autoReconnect()) {
      for (const p of next) {
        if (p.state !== 'disconnected' || this.recovered.has(p.serial)) continue
        this.recovered.add(p.serial)
        void this.recover(p.serial)
      }
    }
    this.phones = next
    const hash = next.map((p) => `${p.serial}:${p.state}`).join('|')
    if (hash !== this.lastHash) {
      this.lastHash = hash
      this.deps.onChange(next, warning)
    }
    return next
  }

  /**
   * `adb mdns services` 로 발견된 접속점 가운데 아직 목록에 없는 것을 `adb connect` 한다.
   * 예전에는 `adb devices` 만 봐서, 와이파이 폰은 사용자가 IP 를 직접 적어야 했고
   * "지금 찾기"로는 영영 안 나왔다(실기: 같은 와이파이의 폰이 "끊김"으로만 보임).
   *  - 같은 폰이 USB 로 이미 붙어 있으면 건너뛴다(한 폰이 두 줄로 보이지 않게)
   *  - 실패한 주소는 잠시 쉬었다가 다시 시도한다(5초 폴링마다 두드리지 않는다)
   * 새로 붙인 것이 있으면 true
   */
  private async connectDiscovered(current: RawDevice[]): Promise<boolean> {
    let services: MdnsService[]
    try {
      services = parseMdnsServices((await this.deps.adb.run(['mdns', 'services'])).stdout)
    } catch {
      // mdns 를 지원하지 않는 adb·방화벽 — 발견 없이 기존 동작 그대로 간다
      return false
    }
    const now = this.deps.now()
    let connected = false
    for (const service of services) {
      if (current.some((d) => d.serial === service.address || d.serial === service.serial)) continue
      if ((this.wifiRetryAt.get(service.address) ?? 0) > now) continue
      this.wifiRetryAt.set(service.address, now + WIFI_CONNECT_COOLDOWN_MS)
      try {
        await this.deps.adb.run(['connect', service.address], 10_000)
        connected = true
      } catch {
        // 연결 실패는 다음 주기에 다시 본다
      }
    }
    return connected
  }

  /**
   * 폰 카드의 "재연결" — kill-server && start-server 를 1회만 시도한다.
   * 자동 복구는 refresh 안에서 기다리지 않고 부르므로 여기서도 던지지 않는다
   */
  async recover(serial: string): Promise<boolean> {
    if (!this.hasAdb()) return false
    try {
      await this.deps.adb.run(['kill-server'])
      await this.deps.adb.run(['start-server'])
      const res = await this.deps.adb.run(['devices', '-l'])
      return parseDevices(res.stdout).some((d) => d.serial === serial && d.state === 'online')
    } catch {
      return false
    }
  }

  async connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    const target = address.includes(':') ? address : `${address}:${WIFI_DEFAULT_PORT}`
    const res = await this.deps.adb.run(['connect', target], 10_000)
    const ok = /connected to/i.test(res.stdout) && !/failed|cannot|unable/i.test(res.stdout)
    if (ok) await this.refresh()
    return { ok, message: res.stdout.trim() || res.stderr.trim() }
  }

  /**
   * 무선 디버깅 페어링(안드로이드 11+). 폰의 "페어링 코드로 기기 페어링" 화면에 뜬 주소와 6자리 코드로
   * 이 PC 의 키를 폰에 등록한다 — USB 를 한 번도 꽂지 않은 폰은 이 길뿐이다.
   * 코드는 폰이 그때그때 만드는 1회용이라 저장하지 않고 로그에도 남기지 않는다
   */
  async pairWifi(address: string, code: string): Promise<{ ok: boolean; message: string }> {
    const target = address.trim()
    const digits = code.replace(/\D/g, '')
    if (!isWifiSerial(target)) return { ok: false, message: tr('phone.pairBadAddress') }
    if (digits.length !== PAIR_CODE_LENGTH) return { ok: false, message: tr('phone.pairBadCode') }
    const res = await this.deps.adb.run(['pair', target, digits], 15_000)
    const ok = /successfully paired/i.test(res.stdout)
    if (ok) {
      // 페어링이 끝나면 접속점(_adb-tls-connect)이 곧 발견된다 — 쉬는 시간을 지우고 바로 찾는다
      this.wifiRetryAt.clear()
      await this.refresh()
    }
    return { ok, message: res.stdout.trim() || res.stderr.trim() }
  }

  async disconnect(serial: string): Promise<void> {
    await this.deps.adb.run(['disconnect', serial])
    await this.refresh()
  }
}
