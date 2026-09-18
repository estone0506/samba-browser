import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { isHttpUrl } from '../shared/url'

// 메인 창 생성. 렌더러(React UI)가 전체를 덮고, 웹뷰는 그 위에 겹쳐 배치
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'SAMBA Browser',
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 38 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/renderer.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 외부 브라우저로 넘기는 건 http/https 만. file:/javascript: 등은 무시한다
    if (isHttpUrl(url)) void shell.openExternal(url)
    else console.warn(`외부 열기 차단: ${url}`)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
