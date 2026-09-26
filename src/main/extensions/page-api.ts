// 확장 문서(팝업·옵션 페이지)의 chrome.* 보충 요청을 받는다(preload/extension-page.ts 짝).
//
// 받아 주는 조건: 보낸 문서가 chrome-extension://<id>/ 이고 그 확장이 세션에 로드돼 있을 때만.
// 쿠키는 manifest 에 cookies 권한이 있을 때만 — 일반 웹 페이지는 이 통로를 쓸 수 없다.
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { declaresCookies, extensionIdOfScope, runCookieOp } from './cookies-bridge'
import { runTabsOp } from './tabs-bridge'

export const EXT_PAGE_CHANNEL = 'samba-ext-page'

let installed = false

/** 보낸 문서의 확장 id 와 manifest. 확장 문서가 아니거나 로드 안 된 확장이면 null */
function senderExtension(e: IpcMainInvokeEvent): { id: string; manifest: unknown } | null {
  const url = e.senderFrame?.url ?? e.sender.getURL()
  const id = extensionIdOfScope(url)
  if (!id) return null
  const ses = e.sender.session
  const ext = ses.extensions?.getExtension?.(id) ?? ses.getExtension?.(id)
  return ext ? { id, manifest: ext.manifest } : null
}

/** 앱 시작 때 한 번 */
export function installExtensionPageApi(): void {
  if (installed) return
  installed = true
  ipcMain.handle(EXT_PAGE_CHANNEL, async (e, api: unknown, op: unknown, details: unknown) => {
    const ext = senderExtension(e)
    if (!ext) return null
    try {
      if (api === 'cookies') {
        if (!declaresCookies(ext.manifest)) return null
        return await runCookieOp(e.sender.session, String(op), details)
      }
      if (api === 'tabs') return runTabsOp(String(op), details, e.sender.session, ext.id)
      return null
    } catch (err: unknown) {
      console.warn('확장 문서 API 처리 실패', ext.id, err instanceof Error ? err.message : String(err))
      return null
    }
  })
}
