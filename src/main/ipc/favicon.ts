// 파비콘 IPC 등록. handlers.ts 와 분리해 둔 이유는 파비콘이 금고·탭·설정 어디에도
// 의존하지 않는 독립 기능이기 때문이다(등록 함수 한 줄만 index.ts 에서 부른다).

import { join } from 'node:path'
import { app, ipcMain, net } from 'electron'
import { IPC, type IpcResult } from '../../shared/ipc'
import { FaviconService, setFaviconService, type FaviconResponse } from '../favicon/service'
import { assertFromRenderer, type RendererWindowLike } from './sender'

export interface FaviconGetResult {
  dataUrl: string | null
}

// win: 렌더러 창. 파비콘 조회도 UI 전용 채널이므로 발신자를 렌더러 창으로 제한한다
export function registerFaviconIpc(win: RendererWindowLike): FaviconService {
  const service = new FaviconService({
    cacheDir: join(app.getPath('userData'), 'favicons'),
    fetch: (url, init) => net.fetch(url, init) as unknown as Promise<FaviconResponse>
  })
  setFaviconService(service)

  ipcMain.handle(IPC.faviconGet, async (e, host: unknown): Promise<IpcResult<FaviconGetResult>> => {
    try {
      assertFromRenderer(win, e.sender)
      if (typeof host !== 'string') return { ok: true, data: { dataUrl: null } }
      return { ok: true, data: { dataUrl: await service.get(host) } }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  return service
}
