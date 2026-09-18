import type { SambaApi } from '../../../preload/renderer'
import type { IpcResult } from '../../../shared/ipc'
import type { DeviceDto } from '../../../shared/sync'

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

declare global {
  interface Window {
    samba: SambaApi & { devices?: SambaDevicesApi }
  }
}

export {}
