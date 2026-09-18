import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { TabManager } from './browser/tab-manager'
import { registerIpc } from './ipc/handlers'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.samba.browser')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  const win = createMainWindow()
  const tabs = new TabManager(win)
  registerIpc(win, tabs)
  tabs.create({ url: 'https://www.google.com' })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
