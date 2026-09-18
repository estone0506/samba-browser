import { BrowserWindow, WebContentsView, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Layout, TabInfo } from '../../shared/ipc'
import { applyMobileEmulation, clearMobileEmulation } from './emulation'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
}

// 탭 = WebContentsView 1개. 프로필은 persist: 파티션으로 쿠키 분리
export class TabManager {
  private tabs: Tab[] = []
  private activeId: string | null = null
  private layout: Layout = { x: 0, y: 0, width: 800, height: 600 }
  private listeners: Array<(tabs: TabInfo[]) => void> = []

  constructor(private win: BrowserWindow) {}

  onChange(cb: (tabs: TabInfo[]) => void): void {
    this.listeners.push(cb)
  }

  private emit(): void {
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  list(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      profile: t.profile,
      mobile: t.mobile,
      loading: t.view.webContents.isLoading(),
      active: t.id === this.activeId
    }))
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  get(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  create(opts: { url?: string; profile?: string; mobile?: boolean } = {}): TabInfo {
    const profile = opts.profile ?? 'default'
    const ses = session.fromPartition(`persist:${profile}`)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(__dirname, '../preload/page.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    const tab: Tab = { id: randomUUID(), view, profile, mobile: opts.mobile ?? false }
    this.tabs.push(tab)
    const wc = view.webContents
    // 상태 변화 이벤트마다 리스너에 통지 (개별 등록: on() 오버로드가 유니온 리터럴을 받지 않음)
    wc.on('did-start-loading', () => this.emit())
    wc.on('did-stop-loading', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-navigate', () => this.emit())
    wc.on('did-navigate-in-page', () => this.emit())
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ url, profile, mobile: tab.mobile })
      return { action: 'deny' }
    })
    if (tab.mobile) applyMobileEmulation(wc)
    void wc.loadURL(opts.url ?? 'https://www.google.com')
    this.activate(tab.id)
    return this.list().find((t) => t.id === tab.id)!
  }

  activate(id: string): void {
    const tab = this.get(id)
    if (!tab) return
    // 모든 탭 뷰를 창에서 제거(없으면 무시됨)한 뒤 활성 탭만 다시 추가
    for (const t of this.tabs) {
      this.win.contentView.removeChildView(t.view)
    }
    this.win.contentView.addChildView(tab.view)
    tab.view.setBounds(this.layout)
    this.activeId = id
    this.emit()
  }

  close(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const [tab] = this.tabs.splice(idx, 1)
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1]
      if (next) this.activate(next.id)
      else this.activeId = null
    }
    this.emit()
  }

  async navigate(id: string, input: string): Promise<void> {
    const tab = this.get(id)
    if (!tab) throw new Error('tab not found')
    await tab.view.webContents.loadURL(toUrl(input))
  }

  back(id: string): void {
    this.get(id)?.view.webContents.navigationHistory.goBack()
  }

  forward(id: string): void {
    this.get(id)?.view.webContents.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.get(id)?.view.webContents.reload()
  }

  setMobile(id: string, mobile: boolean): void {
    const tab = this.get(id)
    if (!tab) return
    tab.mobile = mobile
    if (mobile) applyMobileEmulation(tab.view.webContents)
    else clearMobileEmulation(tab.view.webContents)
    tab.view.webContents.reload()
    this.emit()
  }

  setLayout(l: Layout): void {
    this.layout = l
    this.active()?.view.setBounds(l)
  }
}

// 주소창 입력 → URL. 도메인 형태면 https 붙이고, 아니면 구글 검색
export function toUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
