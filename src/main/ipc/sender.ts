// IPC 발신자 검증 — "렌더러 창(메인 UI)이 보낸 요청인가" 만 판정하는 순수 모듈.
//
// 탭 안의 웹 페이지 preload 도 같은 ipcRenderer 를 쓸 수 있으므로, 금고·설정·가져오기·
// 북마크처럼 UI 전용 채널은 반드시 이 검사를 거쳐야 한다. 페이지가 쓰는 채널
// (vault:capture, vault:pickerAccounts/Fill, newtab:*, settings:get)은 각자의 게이트를 쓴다.
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.

/** BrowserWindow 중 발신자 검증에 필요한 부분만 좁힌 인터페이스 */
export interface RendererWindowLike {
  isDestroyed: () => boolean
  webContents: { id: number; isDestroyed: () => boolean }
}

/** WebContents 중 식별에 필요한 부분만 좁힌 인터페이스 */
export interface SenderLike {
  id: number
}

/** 이 요청이 렌더러 창의 webContents 에서 왔는가 */
export function isFromRenderer(win: RendererWindowLike, sender: SenderLike | null): boolean {
  if (!sender) return false
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  return sender.id === win.webContents.id
}

/** 렌더러 전용 채널에서 발신자를 강제한다. 아니면 던진다({ok:false,error}로 응답됨) */
export function assertFromRenderer(win: RendererWindowLike, sender: SenderLike | null): void {
  if (!isFromRenderer(win, sender)) throw new Error('forbidden: renderer-only channel')
}
