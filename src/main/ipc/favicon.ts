// 파비콘 IPC 등록. handlers.ts 와 분리해 둔 이유는 파비콘이 금고·탭·설정 어디에도
// 의존하지 않는 독립 기능이기 때문이다(등록 함수 한 줄만 index.ts 에서 부른다).

import { join } from 'node:path'
import { app, ipcMain, net } from 'electron'
import { IPC, type IpcResult } from '../../shared/ipc'
import { FaviconService, setFaviconService, type FaviconResponse } from '../favicon/service'

export interface FaviconGetResult {
  dataUrl: string | null
}

export function registerFaviconIpc(): FaviconService {
  const service = new FaviconService({
    cacheDir: join(app.getPath('userData'), 'favicons'),
    fetch: (url, init) => net.fetch(url, init) as unknown as Promise<FaviconResponse>
  })
  setFaviconService(service)

  ipcMain.handle(
    IPC.faviconGet,
    async (_e, host: unknown): Promise<IpcResult<FaviconGetResult>> => {
      if (typeof host !== 'string') return { ok: true, data: { dataUrl: null } }
      try {
        return { ok: true, data: { dataUrl: await service.get(host) } }
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  return service
}
