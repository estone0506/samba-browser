import type { SambaApi } from '../../../preload/renderer'
import type { IpcResult } from '../../../shared/ipc'
import type { DeviceDto } from '../../../shared/sync'
import type { ScreenMode } from '../../../shared/phone'

/**
 * 기기 목록 API.
 * Task 9 에서 preload 에 실제로 노출되며, 아직 없는 빌드에서도 화면이 뜨도록
 * 타입만 먼저 선언해 두고 호출부는 optional chaining 으로 방어한다
 * (없으면 "준비 중" 안내를 보여 준다).
 */
export interface SambaDevicesApi {
  list(): Promise<IpcResult<DeviceDto[]>>
  revoke(id: string): Promise<IpcResult<void>>
}

/**
 * 폰 화면 청크(메인 → 렌더러).
 * 간이 화면은 PNG data URL 한 장, 동영상은 Annex-B h264 바이트 한 토막이 온다
 */
export interface PhoneScreenChunk {
  serial: string
  mode: ScreenMode
  /** 간이 화면(still) — PNG data URL */
  dataUrl?: string
  /** 동영상(video) — Annex-B 바이트 */
  data?: Uint8Array
  /** 동영상 — 키프레임 여부(첫 키프레임 전 청크는 버린다) */
  keyframe?: boolean
}

/**
 * 폰 화면·입력 API.
 * Task 5 에서 preload 에 실제로 노출된다. 아직 없는 빌드에서도 폰 화면이 뜨도록
 * 타입만 먼저 선언해 두고 호출부는 optional chaining 으로 방어한다
 * (없으면 "화면 준비 중" 안내를 보여 준다).
 * 좌표는 0~1 비율로만 보낸다 — 실제 폰 해상도는 메인만 알고 있다
 */
export interface SambaPhoneScreenApi {
  screenStart(serial: string, mode?: ScreenMode): Promise<IpcResult<ScreenMode>>
  screenStop(serial: string): Promise<IpcResult<void>>
  openWindow(serial: string): Promise<IpcResult<void>>
  tap(serial: string, rx: number, ry: number): Promise<IpcResult<void>>
  swipe(
    serial: string,
    rx1: number,
    ry1: number,
    rx2: number,
    ry2: number,
    durationMs?: number
  ): Promise<IpcResult<void>>
  key(serial: string, keyName: string): Promise<IpcResult<void>>
  onScreenChunk(cb: (chunk: PhoneScreenChunk) => void): () => void
}

declare global {
  interface Window {
    samba: SambaApi & {
      devices?: SambaDevicesApi
      phone: SambaApi['phone'] & Partial<SambaPhoneScreenApi>
    }
  }
}

export {}
