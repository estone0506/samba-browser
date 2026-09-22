// 기기 등록·목록·원격 로그아웃.
//
// 원격 devices 표에는 사람이 알아볼 이름(호스트명)·OS·앱 버전·마지막 접속 시각만 올라간다.
// 토큰·비밀값은 어느 방향으로도 지나가지 않는다.
// 다른 PC 에서 이 기기를 취소(revoke)하면, 이 PC 는 다음 동기화 주기에 그것을 보고
// 스스로 로그아웃하고 금고를 잠근다(연결은 sync/connect.ts 가 한다)

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import type { DeviceDto } from '../../shared/sync'
import type { RemoteRow, SyncBackend } from './backend'
import { SyncLocal } from './local'
import { fromIso, fromIsoOrNull, toIso } from './mappers'
import { tr } from '../i18n'

/** 원격 기기 표 이름. 다른 표와 달리 `_sync` 접미사가 없다 */
export const DEVICES_TABLE = 'devices'

/** 이 PC 의 기기 id 를 담아 두는 sync_state 키 */
export const DEVICE_ID_KEY = 'deviceId'

export interface DeviceDeps {
  backend: SyncBackend
  db: Db
  userId: string
  /** 기기 이름 기본값(os.hostname()) */
  hostname: () => string
  /** `${os.type()} ${os.release()}` */
  osLabel: () => string
  /** app.getVersion() — 테스트에서는 주입한다 */
  appVersion: () => string
}

/** 이 PC 의 기기 등록이 다른 기기에서 취소된 상태 — 호출부는 로그아웃·잠금으로 처리한다 */
export class DeviceRevokedError extends Error {
  constructor() {
    super(tr('sync.deviceRevoked'))
    this.name = 'DeviceRevokedError'
  }
}

export class DeviceService {
  private readonly local: SyncLocal

  constructor(private readonly deps: DeviceDeps) {
    this.local = new SyncLocal(deps.db)
  }

  /** 이 PC 에 저장된 기기 id. 아직 등록 전이면 null */
  currentId(): string | null {
    return this.local.getState(DEVICE_ID_KEY)
  }

  /**
   * 이 PC 를 원격 기기 목록에 올린다. 이미 있으면 같은 id 로 정보만 새로 쓴다.
   * 취소 표식은 여기서 지워진다 — 다시 로그인한 기기까지 막으면 그 PC 는 영영 들어올 수 없다
   */
  async ensureRegistered(): Promise<string> {
    const id = this.currentId() ?? randomUUID()
    // 다른 기기에서 취소된 행이면 되살리지 않는다(revoked_at 을 null 로 덮으면 원격 로그아웃이 무효가 된다)
    const existing = this.currentId() ? await this.fetch(id) : null
    if (existing && fromIsoOrNull(existing.revoked_at) !== null) {
      throw new DeviceRevokedError()
    }
    await this.deps.backend.upsert(DEVICES_TABLE, [
      {
        id,
        user_id: this.deps.userId,
        name: this.deps.hostname(),
        os: this.deps.osLabel(),
        app_version: this.deps.appVersion(),
        last_seen_at: toIso(Date.now()),
        revoked_at: null
      }
    ])
    // 전송에 성공한 뒤에 적는다 — 실패하면 다음에 같은 자리에서 다시 시도한다
    this.local.setState(DEVICE_ID_KEY, id)
    return id
  }

  /**
   * 설정 화면의 기기 목록. 최근에 본 기기가 위로 온다.
   * 등록은 하지 않는다 — ensureRegistered 는 취소 표식을 지우므로, 목록을 여는 것만으로
   * 원격 로그아웃이 풀려서는 안 된다(등록은 로그인 직후 connect 가 한 번 한다)
   */
  async list(): Promise<DeviceDto[]> {
    const current = this.currentId()
    const rows = await this.deps.backend.selectAll(DEVICES_TABLE)
    return rows.map((row) => toDeviceDto(row, current)).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** 기기 하나를 원격 로그아웃시킨다. 그 PC 는 다음 동기화 주기에 스스로 나간다 */
  async revoke(deviceId: string): Promise<void> {
    const row = await this.fetch(deviceId)
    if (!row) throw new Error(tr('sync.deviceNotFound'))
    await this.deps.backend.upsert(DEVICES_TABLE, [{ ...row, revoked_at: toIso(Date.now()) }])
  }

  /** 마지막 접속 시각만 갱신한다(동기화 주기마다). 취소 표식은 건드리지 않는다 */
  async heartbeat(): Promise<void> {
    const id = this.currentId()
    if (!id) return
    const row = await this.fetch(id)
    // 원격에서 행이 통째로 사라졌으면(계정 정리 등) 다시 등록한다
    if (!row) {
      await this.ensureRegistered()
      return
    }
    await this.deps.backend.upsert(DEVICES_TABLE, [{ ...row, last_seen_at: toIso(Date.now()) }])
  }

  /** 이 PC 가 다른 기기에서 취소됐는가 */
  async isRevoked(): Promise<boolean> {
    const id = this.currentId()
    if (!id) return false
    const row = await this.fetch(id)
    if (!row) return false
    return fromIsoOrNull(row.revoked_at) !== null
  }

  private async fetch(deviceId: string): Promise<RemoteRow | null> {
    const rows = await this.deps.backend.selectAll(DEVICES_TABLE)
    return rows.find((row) => row.id === deviceId) ?? null
  }
}

function toDeviceDto(row: RemoteRow, currentId: string | null): DeviceDto {
  return {
    id: row.id,
    name: asText(row.name) || tr('sync.unnamedDevice'),
    os: asText(row.os),
    appVersion: asText(row.app_version),
    lastSeenAt: fromIso(row.last_seen_at),
    revokedAt: fromIsoOrNull(row.revoked_at),
    isCurrent: row.id === currentId
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
