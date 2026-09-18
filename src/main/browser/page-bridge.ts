import type { WebContents } from 'electron'
import type { PageSnapshot } from '../../shared/snapshot'
import type { Tab } from './tab-manager'

// 탭 안 preload(window.__samba)를 executeJavaScript로 호출. 값은 JSON으로 왕복
async function call<T>(wc: WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(expr, true)) as T
}

export const pageBridge = {
  snapshot: (tab: Tab): Promise<PageSnapshot> =>
    call<PageSnapshot>(tab.view.webContents, 'window.__samba.snapshot()'),
  // 요소 [id] 의 실제 페이지 텍스트. 없으면 빈 문자열
  textOf: (tab: Tab, id: number): Promise<string> =>
    call<string>(tab.view.webContents, `window.__samba.textOf(${id})`),
  click: (tab: Tab, id: number): Promise<string> =>
    call<string>(tab.view.webContents, `window.__samba.click(${id})`),
  type: (tab: Tab, id: number, text: string, submit: boolean): Promise<string> =>
    call<string>(
      tab.view.webContents,
      `window.__samba.type(${id}, ${JSON.stringify(text)}, ${submit})`
    ),
  select: (tab: Tab, id: number, value: string): Promise<string> =>
    call<string>(tab.view.webContents, `window.__samba.select(${id}, ${JSON.stringify(value)})`),
  scroll: (tab: Tab, dir: 'up' | 'down'): Promise<string> =>
    call<string>(tab.view.webContents, `window.__samba.scroll(${JSON.stringify(dir)})`),
  waitForLoad: (tab: Tab, timeoutMs = 10000): Promise<void> =>
    new Promise<void>((resolve) => {
      const wc = tab.view.webContents
      if (!wc.isLoading()) {
        resolve()
        return
      }
      const t = setTimeout(done, timeoutMs)
      function done(): void {
        clearTimeout(t)
        wc.off('did-stop-loading', done)
        resolve()
      }
      wc.on('did-stop-loading', done)
    })
}
