// vitest 용 electron 모듈 스텁. tab-manager.ts 가 import 하는 이름만 빈 값으로 내보냄
export const session = {}
export class WebContentsView {}
export class BrowserWindow {}
export const shell = {}
// ocr/engine.ts 가 모델 보관 위치를 계산할 때 쓴다(테스트는 경로를 직접 주입한다)
export const app = { getPath: (_name: string): string => '' }
// browser/context-menu.ts 가 import 하는 이름(순수 함수만 테스트하므로 빈 값으로 둔다)
export const Menu = { buildFromTemplate: () => ({ popup: (): void => undefined }) }
export const clipboard = { writeText: (_text: string): void => undefined }
export const nativeImage = {}
// browser/frame-channel.ts 가 iframe 응답을 받기 위해 쓴다(테스트는 프레임 호출을 직접 주입한다)
export const ipcMain = {
  on: (_channel: string, _listener: (...args: unknown[]) => void): void => undefined,
  removeListener: (_channel: string, _listener: (...args: unknown[]) => void): void => undefined
}
