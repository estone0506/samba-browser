import { join } from 'node:path'
import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { TabManager } from './browser/tab-manager'
import { registerIpc } from './ipc/handlers'
import { openDatabase, type Db } from './db/client'

// 어디서도 잡지 못한 Promise 거부는 조용히 사라지지 않게 기록한다
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 Promise 거부', reason)
})

// before-quit 시점에 db.close() 를 호출해야 하므로 모듈 스코프로 올려둔다
let db: Db | undefined

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.samba.browser')
    app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
    const win = createMainWindow()
    const tabs = new TabManager(win)
    db = await openDatabase(join(app.getPath('userData'), 'data.db'))
    registerIpc(win, tabs, db)
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

// 종료 직전 DB 를 안전하게 저장/닫는다(내부적으로 pending save 를 즉시 flush 함)
app.on('before-quit', () => {
  try {
    db?.close()
  } catch (e: unknown) {
    console.error('DB 종료 실패', e)
  }
})
