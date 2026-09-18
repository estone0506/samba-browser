import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

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
    webPreferences: { preload: join(__dirname, '../preload/renderer.js'), sandbox: false }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
