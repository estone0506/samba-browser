import { BrowserWindow, WebContentsView, session, type Session, type WebContents } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Layout, TabInfo } from '../../shared/ipc'
import { BLOCKED_URL_MESSAGE, isAllowedUrl } from '../../shared/url'
import { applyMobileEmulation, clearMobileEmulation, MOBILE_WIDTH } from './emulation'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
}

const DEFAULT_URL = 'https://www.google.com'

// 렌더러가 보고한 좌표를 "현재" 창 콘텐츠 크기에 다시 투영한다.
// 렌더러는 보고 시점의 뷰포트 크기를 함께 보내므로, 거기서 오른쪽·아래 여백을 뽑아
// 지금 창 크기에 그대로 적용한다. 창 크기가 바뀌는 동안 렌더러의 재보고가
// 늦거나 누락돼도(크기 변경 중 렌더링 파이프라인이 지연되면 실제로 생긴다)
// 웹뷰가 카드 아래·오른쪽으로 삐져나오지 않는다.
// mobile=true 이면 웹뷰를 웨일 모바일 창처럼 가운데 412px 폭 카드로 좁힌다.
// 폭만 좁히고 x 를 다시 계산할 뿐, y·높이는 그대로 둔다(세로는 전체 유지하기로 결정)
export function computeViewBounds(
  l: Layout,
  contentWidth: number,
  contentHeight: number,
  mobile = false
): Layout {
  const empty = { x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  if (l.width <= 0 || l.height <= 0) return empty
  // 뷰포트 정보가 없는 오래된 보고는 좌표를 그대로 쓴다(하위 호환)
  const gapRight = l.viewportWidth > 0 ? Math.max(0, l.viewportWidth - (l.x + l.width)) : 0
  const gapBottom = l.viewportHeight > 0 ? Math.max(0, l.viewportHeight - (l.y + l.height)) : 0
  const width = l.viewportWidth > 0 ? contentWidth - l.x - gapRight : l.width
  const height = l.viewportHeight > 0 ? contentHeight - l.y - gapBottom : l.height
  if (width <= 0 || height <= 0) return empty
  if (mobile) {
    // "현재" 창 크기로 재투영된 width 를 기준으로 좁힌다(창 크기 변경 중에도 카드가 어긋나지 않게)
    const mobileWidth = Math.min(MOBILE_WIDTH, width)
    const mobileX = l.x + Math.floor((width - mobileWidth) / 2)
    return {
      x: mobileX,
      y: l.y,
      width: mobileWidth,
      height,
      viewportWidth: contentWidth,
      viewportHeight: contentHeight
    }
  }
  return {
    x: l.x,
    y: l.y,
    width,
    height,
    viewportWidth: contentWidth,
    viewportHeight: contentHeight
  }
}

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
  private layout: Layout = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    viewportWidth: 0,
    viewportHeight: 0
  }
  private listeners: Array<(tabs: TabInfo[]) => void> = []
  private disposed = false

  constructor(private win: BrowserWindow) {
    // 창이 닫히면 남은 리스너·탭을 정리해 파괴된 창에 접근하지 않게 한다
    win.once('closed', () => this.dispose())
    // 창 크기가 바뀌면 렌더러 보고를 기다리지 않고 메인이 먼저 맞춘다.
    // (최대화·복원·드래그 리사이즈 때 렌더러 보고가 누락되면 이전 크기가 그대로 남아
    //  웹페이지가 카드 밖까지 그려지던 문제를 막는다)
    win.on('resize', () => this.applyBounds())
    // 최대화·복원은 resize 가 중간 크기로 한 번 먼저 오고 최종 크기가 나중에 확정되므로
    // 끝난 뒤에 한 번 더 맞춘다
    win.on('maximize', () => this.applyBounds())
    win.on('unmaximize', () => this.applyBounds())
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

  // IPC 발신자가 실제로 관리 중인 탭의 webContents 인지 확인(위조 발신자 방지, vault:capture 검증용)
  hasWebContents(wc: WebContents): boolean {
    return this.tabs.some((t) => t.view.webContents === wc)
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
    // WebContentsView 는 네이티브 레이어라 CSS overflow-hidden 으로 잘리지 않는다.
    // setBorderRadius 는 4개 모서리를 한 번에 같은 값으로만 설정할 수 있어(상단만 둥글게 불가),
    // 카드가 상단만 둥글고(rounded-t-2xl) 하단은 창 바닥에 닿는 edge-to-edge 레이아웃에서는
    // 0 으로 둬 하단 사각 모서리와 일치시킨다(상단은 카드 테두리 뒤에 가려져 시각적으로 차이가 적다)
    view.setBorderRadius(0)
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
    this.activeId = id
    this.applyBounds()
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
    // 뷰 bounds(가운데 정렬 여부)는 에뮬레이션 통신을 기다릴 필요 없이 즉시 반영한다
    this.applyBounds()
    const wc = tab.view.webContents
    // 에뮬레이션 적용/해제가 끝난 뒤에 새로고침해야 UA·뷰포트가 반영된다
    if (mobile) await applyMobileEmulation(wc)
    else await clearMobileEmulation(wc)
    if (!wc.isDestroyed()) wc.reload()
    this.emit()
  }

  setLayout(l: Layout): void {
    this.layout = l
    this.applyBounds()
  }

  // 저장된 좌표를 현재 창 크기에 맞춰 활성 탭에 적용. mobile 탭이면 가운데 412px 카드로 좁힌다
  private applyBounds(): void {
    if (this.disposed || this.win.isDestroyed()) return
    const tab = this.active()
    if (!tab) return
    const [w, h] = this.win.getContentSize()
    tab.view.setBounds(computeViewBounds(this.layout, w, h, tab.mobile))
  }
}

// 주소창 입력 → URL. 도메인 형태면 https 붙이고, 아니면 구글 검색
export function toUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
