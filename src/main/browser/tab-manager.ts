import { BrowserWindow, WebContentsView, session, type Session, type WebContents } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Layout, TabInfo } from '../../shared/ipc'
import { BLOCKED_URL_MESSAGE, isAllowedUrl } from '../../shared/url'
import { applyMobileEmulation, clearMobileEmulation } from './emulation'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
}

const DEFAULT_URL = 'https://www.google.com'

// 이미 하드닝한 파티션 이름. session.fromPartition 은 같은 인스턴스를 돌려주므로 1회만 건다
const hardenedPartitions = new Set<string>()

// 세션 기본 거부 정책: 권한 요청·권한 조회·다운로드를 모두 막는다(1단계 범위)
function hardenSession(ses: Session, partition: string): void {
  if (hardenedPartitions.has(partition)) return
  hardenedPartitions.add(partition)
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn(`권한 요청 거부: ${permission}`)
    callback(false)
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    console.warn(`권한 조회 거부: ${permission}`)
    return false
  })
  ses.on('will-download', (e, item) => {
    e.preventDefault()
    console.warn(`다운로드 차단: ${item.getURL()}`)
  })
}

// 리다이렉트·페이지 내 이동으로 금지 스킴에 도달하는 경로까지 막는다
function guardNavigation(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (isAllowedUrl(url)) return
    e.preventDefault()
    console.warn(`이동 차단: ${url}`)
  })
  wc.on('will-redirect', (e, url) => {
    if (isAllowedUrl(url)) return
    e.preventDefault()
    console.warn(`리다이렉트 차단: ${url}`)
  })
}

// 탭 = WebContentsView 1개. 프로필은 persist: 파티션으로 쿠키 분리
export class TabManager {
  private tabs: Tab[] = []
  private activeId: string | null = null
  private layout: Layout = { x: 0, y: 0, width: 800, height: 600 }
  private listeners: Array<(tabs: TabInfo[]) => void> = []
  private disposed = false

  constructor(private win: BrowserWindow) {
    // 창이 닫히면 남은 리스너·탭을 정리해 파괴된 창에 접근하지 않게 한다
    win.once('closed', () => this.dispose())
  }

  onChange(cb: (tabs: TabInfo[]) => void): void {
    this.listeners.push(cb)
  }

  private emit(): void {
    if (this.disposed) return
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  // 창이 사라진 뒤 호출되는 늦은 이벤트를 무시하기 위한 정리
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners = []
    this.tabs = []
    this.activeId = null
  }

  list(): TabInfo[] {
    return this.tabs
      .filter((t) => !t.view.webContents.isDestroyed())
      .map((t) => ({
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
    if (this.disposed) throw new Error('window closed')
    const url = opts.url ?? DEFAULT_URL
    // 탭 생성 경로(주소창·AI new_tab·페이지의 window.open)의 공통 관문
    if (!isAllowedUrl(url)) throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
    const profile = opts.profile ?? 'default'
    const partition = `persist:${profile}`
    const ses = session.fromPartition(partition)
    hardenSession(ses, partition)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(__dirname, '../preload/page.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    // 카드 모서리(rounded-2xl = 16px)와 맞춰서, 창 모서리 사각형 삐져나옴을 없앤다
    view.setBorderRadius(16)
    const tab: Tab = { id: randomUUID(), view, profile, mobile: opts.mobile ?? false }
    this.tabs.push(tab)
    const wc = view.webContents
    // 상태 변화 이벤트마다 리스너에 통지 (개별 등록: on() 오버로드가 유니온 리터럴을 받지 않음)
    wc.on('did-start-loading', () => this.emit())
    wc.on('did-stop-loading', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-navigate', () => this.emit())
    wc.on('did-navigate-in-page', () => this.emit())
    guardNavigation(wc)
    wc.setWindowOpenHandler(({ url: target }) => {
      if (!isAllowedUrl(target)) {
        console.warn(`새 창 차단: ${target}`)
        return { action: 'deny' }
      }
      this.create({ url: target, profile, mobile: tab.mobile })
      return { action: 'deny' }
    })
    if (tab.mobile) void applyMobileEmulation(wc)
    void wc.loadURL(url)
    this.activate(tab.id)
    return this.list().find((t) => t.id === tab.id)!
  }

  activate(id: string): void {
    const tab = this.get(id)
    if (!tab || this.win.isDestroyed()) return
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
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
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
    const url = toUrl(input)
    if (!isAllowedUrl(url)) throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
    await tab.view.webContents.loadURL(url)
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

  async setMobile(id: string, mobile: boolean): Promise<void> {
    const tab = this.get(id)
    if (!tab) return
    tab.mobile = mobile
    const wc = tab.view.webContents
    // 에뮬레이션 적용/해제가 끝난 뒤에 새로고침해야 UA·뷰포트가 반영된다
    if (mobile) await applyMobileEmulation(wc)
    else await clearMobileEmulation(wc)
    if (!wc.isDestroyed()) wc.reload()
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
