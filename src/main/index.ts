import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { TabManager } from './browser/tab-manager'
import { registerIpc } from './ipc/handlers'

// 어디서도 잡지 못한 Promise 거부는 조용히 사라지지 않게 기록한다
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 Promise 거부', reason)
})

app
  .whenReady()
  .then(() => {
    electronApp.setAppUserModelId('com.samba.browser')
    app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
    const win = createMainWindow()
    const tabs = new TabManager(win)
    registerIpc(win, tabs)
    tabs.create({ url: 'https://www.google.com' })
    // macOS 의 activate 재생성은 1단계(Windows 전용) 범위 밖이라 배선하지 않는다
  })
  .catch((e: unknown) => {
    console.error('앱 초기화 실패', e)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
