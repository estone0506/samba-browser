import { join } from 'node:path'
import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { TabManager } from './browser/tab-manager'
import { registerIpc } from './ipc/handlers'
import { openDatabase, type Db } from './db/client'
import type { VaultService } from './vault/service'
import { runLoginHarness, writeVaultLocked } from './e2e/login-harness'

// E2E 하네스용 userData 분리 — 실행 중인 사용자 앱의 DB 를 건드리지 않기 위해 복사본을 쓴다.
// app.whenReady() 이전에 지정해야 하므로 모듈 최상단에서 처리한다
const userDataOverride = process.env.SAMBA_USER_DATA
if (userDataOverride) app.setPath('userData', userDataOverride)

// 어디서도 잡지 못한 Promise 거부는 조용히 사라지지 않게 기록한다
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 Promise 거부', reason)
})

// 종료 정리(shutdown)에서 써야 하므로 모듈 스코프로 올려둔다
let db: Db | undefined
let vault: VaultService | undefined

// 종료 순서: vault.dispose()(lock 포함, DB 조회 발생) → db.close() 순으로 해야 한다.
// 반대로 하면(예전 버그) db.close() 뒤에 창이 닫히며 vault.dispose() → lock() →
// pruneDeviceWrappedKeyIfDisabled() 가 이미 닫힌 sql.js 핸들에 쿼리를 날려 'out of memory'
// 예외가 Uncaught 로 터진다. before-quit 과 창 closed 이벤트 양쪽에서 호출될 수 있으므로
// db.close()/vault.dispose() 자체도 멱등하지만, 이 함수도 한 번만 실제로 동작하게 막아 둔다
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    vault?.dispose()
  } catch (e: unknown) {
    console.error('금고 종료 실패', e)
  }
  try {
    db?.close()
  } catch (e: unknown) {
    console.error('DB 종료 실패', e)
  }
}

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.samba.browser')
    app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
    const win = createMainWindow()
    const tabs = new TabManager(win)
    db = await openDatabase(join(app.getPath('userData'), 'data.db'))
    const ipc = registerIpc(win, tabs, db)
    vault = ipc.vault
    // 하네스 모드: 저장된 사이트를 순회하며 자동 로그인을 검증하고 끝나면 앱을 종료한다
    const e2eTarget = process.env.SAMBA_E2E_LOGIN
    if (e2eTarget) {
      const outFile = process.env.SAMBA_E2E_OUT ?? 'docs/검수/e2e-login-results.md'
      await vault.ensureUnlockedByDevice()
      if (vault.state() !== 'unlocked') {
        // 기기 키(DPAPI)는 Chromium 의 OSCrypt 키에 묶여 있어, DB 뿐 아니라 userData 의
        // "Local State" 파일까지 함께 복사해야 복사본에서도 자동 해제가 된다
        console.error('[e2e] vault locked — data.db 와 함께 "Local State" 도 복사했는지 확인')
        writeVaultLocked(outFile)
        app.quit()
        return
      }
      const limit = Number(process.env.SAMBA_E2E_LIMIT ?? '0')
      await runLoginHarness(
        { tabs, vault },
        {
          hosts: e2eTarget === 'all' ? 'all' : e2eTarget.split(',').map((h) => h.trim()),
          outFile,
          limit: Number.isFinite(limit) ? limit : 0,
          resume: process.env.SAMBA_E2E_RESUME === '1'
        }
      )
      app.quit()
      return
    }
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

// 종료 직전 금고를 먼저 잠그고 DB 를 안전하게 저장/닫는다(내부적으로 pending save 를 즉시 flush 함)
app.on('before-quit', () => {
  shutdown()
})
