import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  type Input,
  type Session,
  type WebContents
} from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC, type Layout, type TabInfo } from '../../shared/ipc'
import type { ClosedTabRecord } from './gestures'
import {
  BLOCKED_URL_MESSAGE,
  isAllowedUrl,
  isExtensionUrl,
  isInternalUrl,
  NEW_TAB_URL
} from '../../shared/url'
import { attachInternalProtocol } from './internal-protocol'
import type { PermissionMode, SearchEngine } from '../../shared/settings'
import { applyMobileEmulation, clearMobileEmulation, MOBILE_WIDTH } from './emulation'
import { installWebstoreUserAgent } from './webstore-ua'
import { installDialogHandler, isAutomationActive } from './dialogs'
import { getFaviconService, type FaviconResponse } from '../favicon/service'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
  // 이 탭을 window.open 으로 띄운 탭. 결제창처럼 별도 WebContents 로 열리는 팝업을
  // 부모 탭에서 다시 찾기 위해 남긴다(결제 성공 리다이렉트 확인에 쓴다)
  openerId?: string
}

// 설정을 아직 못 읽었을 때의 기본 주소. 설정이 들어오면 setDefaultUrl 로 덮인다
const DEFAULT_URL = NEW_TAB_URL

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
  // 웹스토어는 Electron UA 를 보면 "지원되지 않는 브라우저" 안내로 설치 버튼을 감춘다.
  // 그 호스트 요청에만 크롬 UA 를 보낸다(다른 사이트는 그대로)
  installWebstoreUserAgent(ses)
}

// 리다이렉트·페이지 내 이동으로 금지 스킴에 도달하는 경로까지 막는다.
// allowExtension 은 확장 문서(옵션 페이지)를 담은 탭에만 준다 — 그 탭 안에서는
// `chrome-extension://` 사이 이동이 정상이기 때문이다(웹 페이지 탭에는 주지 않는다)
function guardNavigation(wc: WebContents, allowExtension: boolean): void {
  const allowed = (url: string): boolean =>
    isAllowedUrl(url) || (allowExtension && isExtensionUrl(url))
  wc.on('will-navigate', (e, url) => {
    if (allowed(url)) return
    e.preventDefault()
    console.warn(`이동 차단: ${url}`)
  })
  wc.on('will-redirect', (e, url) => {
    if (allowed(url)) return
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
  // 탭 전환 구독자(확장 액션 팝업을 닫는다)
  private activatedListeners: Array<() => void> = []
  private disposed = false
  // === 홈 버튼 / 설정 페이지 (신규 추가분) ==================================
  // url 없이 탭을 생성할 때 쓸 기본 주소(설정의 홈 주소/새 탭 주소로부터 계산되어 들어온다)
  private defaultUrl = DEFAULT_URL
  // 주소창 검색어 → URL 변환에 쓸 기본 검색엔진
  private searchEngine: SearchEngine = 'google'
  // 탭 세션 파티션 접두사. 작업공간이 바뀌면 handlers 가 갈아 끼운다.
  // 이미 열려 있는 탭의 세션은 건드리지 않고, 새로 여는 탭부터 새 파티션을 쓴다
  private partitionPrefix = 'persist:'
  // 이 창이 실제로 만든 파티션 세션. 새 파티션이 생기면 확장 관리자에게 알려 준다
  private partitionSessions = new Map<string, Session>()
  private sessionHook: ((ses: Session, partition: string) => void) | null = null
  // 탭 우클릭 메뉴 설치 훅(번역 메뉴). 주입하지 않으면 메뉴를 붙이지 않는다
  private contextMenuHook: ((wc: WebContents) => void) | null = null
  // 창 안에서만 듣는 키 입력 처리기(작업공간 Ctrl+Alt+1~9). true 를 돌려주면 페이지로 넘기지 않는다
  private inputHandler: ((input: Input) => boolean) | null = null
  // === 신규 추가분 끝 ========================================================
  // AI 작업이 실행 중인지 알려 주는 판정기(handlers 가 AgentRunner 를 연결한다).
  // 페이지 JS 대화상자는 작업 실행 중에만 자동 처리한다
  private agentRunning: () => boolean = () => false
  // 대화상자 처리 정책(사용 권한 모드 + 사용자 확인 수단). handlers 가 연결한다
  private dialogMode: () => PermissionMode = () => 'guard'
  private dialogConfirm: ((message: string) => Promise<boolean>) | undefined
  // 자동 처리한 대화상자 문구(탭별 1건). 다음 도구 결과 앞에 붙이고 비운다
  private lastDialogMessage = new Map<string, string>()
  // === 마우스 제스처 ========================================================
  // 페이지 preload 에 밀어 줄 제스처 설정(켜짐 여부·언어·매핑). 설정이 바뀌면 handlers 가 갈아 끼운다
  private gestureConfig: unknown = null
  // 탭이 닫힐 때 알리는 구독자(닫은 탭 다시 열기 스택)
  private closedListeners: Array<(tab: ClosedTabRecord) => void> = []
  // === 마우스 제스처 끝 ======================================================

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

  /**
   * 탭이 활성화될 때 알린다(확장 액션 팝업 닫기).
   * onChange 와 나눠 둔 이유는 onChange 가 로딩·제목 변경에도 매번 불리기 때문이다
   */
  onActivated(cb: () => void): void {
    this.activatedListeners.push(cb)
  }

  // === 홈 버튼 / 설정 페이지 (신규 추가분) ==================================
  // handlers.ts 가 설정 로드/변경 시 호출한다. tab-manager 는 newTabUrl·homeUrl
  // 조합 로직을 모르고, 이미 계산된 최종 URL 문자열만 받는다
  setDefaultUrl(url: string): void {
    this.defaultUrl = url
  }

  setSearchEngine(engine: SearchEngine): void {
    this.searchEngine = engine
  }

  /**
   * 탭 세션 파티션 접두사를 바꾼다(작업공간 전환).
   * 열려 있는 탭은 그대로 두고 새 탭부터 적용된다 — 진행 중인 로그인 세션을 끊지 않기 위해서다
   */
  setPartitionPrefix(prefix: string): void {
    this.partitionPrefix = prefix
  }

  /**
   * 파티션 세션이 처음 만들어질 때 호출될 처리기를 연결한다(확장 재로드용).
   * 이미 만들어 둔 세션에는 곧바로 한 번씩 적용한다
   */
  setSessionHook(fn: (ses: Session, partition: string) => void): void {
    this.sessionHook = fn
    for (const [partition, ses] of this.partitionSessions) fn(ses, partition)
  }

  /** 탭 우클릭 메뉴 설치 훅을 연결한다. 이미 열려 있는 탭에도 소급 적용한다 */
  setContextMenuHook(fn: (wc: WebContents) => void): void {
    this.contextMenuHook = fn
    for (const tab of this.tabs) fn(tab.view.webContents)
  }

  /**
   * 창 안에서만 동작하는 키 입력 처리기를 연결한다(작업공간 전환 단축키).
   * 처리기가 true 를 돌려주면 그 입력은 페이지로 전달되지 않는다
   */
  setInputHandler(fn: (input: Input) => boolean): void {
    this.inputHandler = fn
    // 이미 열려 있는 탭에도 소급 적용한다
    for (const tab of this.tabs) this.attachInputHandler(tab.view.webContents)
  }

  private attachInputHandler(wc: WebContents): void {
    wc.on('before-input-event', (e, input) => {
      if (this.inputHandler?.(input)) e.preventDefault()
    })
  }

  // === 마우스 제스처 ========================================================
  /**
   * 페이지 preload 에 밀어 줄 제스처 설정을 갈아 끼운다.
   * 이미 열려 있는 탭에도 즉시 반영한다(설정 화면에서 끄면 바로 궤적이 사라지도록)
   */
  setGestureConfig(config: unknown): void {
    this.gestureConfig = config
    for (const tab of this.tabs) this.sendGestureConfig(tab.view.webContents)
  }

  private sendGestureConfig(wc: WebContents): void {
    if (this.gestureConfig === null || wc.isDestroyed()) return
    wc.send(IPC.pageGestureConfig, this.gestureConfig)
  }

  /** 탭이 닫힐 때(다시 열기 스택에 쌓을 수 있게) 알린다 */
  onTabClosed(cb: (tab: ClosedTabRecord) => void): void {
    this.closedListeners.push(cb)
  }

  /**
   * 페이지를 맨 위·맨 아래로 보낸다(제스처 ↑/↓).
   * 페이지가 window.scrollTo 를 덮어썼어도 영향을 받지 않도록 격리 월드에서 실행한다
   */
  async scrollTo(id: string, to: 'top' | 'bottom'): Promise<void> {
    const tab = this.get(id)
    if (!tab) return
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const top = to === 'top' ? '0' : 'el.scrollHeight'
    // preload 가 사는 격리 월드 id(Electron WorldId.ISOLATED_WORLD). page-bridge 와 같은 값이지만
    // 순환 import 를 만들지 않으려고 여기서는 숫자를 직접 쓴다
    await wc.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `(() => { const el = document.scrollingElement || document.documentElement; el.scrollTo({ top: ${top}, behavior: 'smooth' }); return '' })()`
      }
    ])
  }
  // === 마우스 제스처 끝 ======================================================

  /** AI 작업 실행 여부 판정기를 연결한다(대화상자 자동 처리 조건) */
  setAgentRunningProvider(fn: () => boolean): void {
    this.agentRunning = fn
  }

  /**
   * 페이지 대화상자 처리 정책을 연결한다.
   * guard 모드의 confirm/beforeunload 는 confirm 으로 사용자 승인을 받는다
   */
  setDialogPolicy(policy: {
    mode: () => PermissionMode
    confirm?: (message: string) => Promise<boolean>
  }): void {
    this.dialogMode = policy.mode
    this.dialogConfirm = policy.confirm
  }

  /**
   * 자동 처리한 대화상자 문구를 한 번 꺼내고 비운다.
   * tabId 를 생략하면 활성 탭 기준이다(도구 결과에 붙일 때 쓴다)
   */
  takeDialogMessage(tabId?: string): string | null {
    const id = tabId ?? this.activeId
    if (!id) return null
    const message = this.lastDialogMessage.get(id)
    if (message === undefined) return null
    this.lastDialogMessage.delete(id)
    return message
  }
  // === 신규 추가분 끝 ========================================================

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
    this.activatedListeners = []
    this.closedListeners = []
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

  // IPC 발신자에 해당하는 탭(새 탭 페이지가 자기 탭을 이동시킬 때 쓴다)
  findByWebContents(wc: WebContents): Tab | null {
    return this.tabs.find((t) => t.view.webContents === wc) ?? null
  }

  /**
   * 이 탭이 띄운 팝업 중 아직 살아 있는 가장 최근 것.
   * 간편결제처럼 결제창이 별도 WebContents 로 열리는 사이트에서 성공 리다이렉트를 확인할 때 쓴다
   */
  popupOf(openerId: string): Tab | null {
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const t = this.tabs[i]
      if (t.openerId === openerId && !t.view.webContents.isDestroyed()) return t
    }
    return null
  }

  create(
    opts: {
      url?: string
      profile?: string
      mobile?: boolean
      openerId?: string
      /**
       * 확장 문서(옵션 페이지) 탭인가. 앱이 스스로 여는 경로(툴바 액션)에서만 켠다 —
       * 주소창 입력·웹페이지의 window.open·AI 도구는 이 값을 주지 않으므로
       * `chrome-extension://` 은 그쪽으로는 여전히 열리지 않는다
       */
      extension?: boolean
      /**
       * 페이지의 window.open 이 만든 뷰(setWindowOpenHandler 의 createWindow 경로).
       * 이미 만들어진 뷰를 탭으로 등록만 하고, 로드는 Electron 이 하므로 loadURL 을 부르지 않는다
       */
      view?: WebContentsView
    } = {}
  ): TabInfo {
    if (this.disposed) throw new Error('window closed')
    // url 이 없으면(새 탭 버튼·첫 탭) 설정에서 계산된 기본 주소를 쓴다
    const url = opts.url ? opts.url : this.defaultUrl
    const allowExtension = opts.extension === true
    // 탭 생성 경로(주소창·AI new_tab·페이지의 window.open)의 공통 관문
    if (!isAllowedUrl(url) && !(allowExtension && isExtensionUrl(url))) {
      throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
    }
    const profile = opts.profile ?? 'default'
    const partition = `${this.partitionPrefix}${profile}`
    const ses = session.fromPartition(partition)
    hardenSession(ses, partition)
    // 파티션 세션에도 samba:// 핸들러를 붙인다(기본 세션 등록만으로는 탭에서 안 열림)
    attachInternalProtocol(ses)
    // 처음 보는 파티션이면 확장 관리자에게 알려 같은 확장을 이 세션에도 걸게 한다
    if (!this.partitionSessions.has(partition)) {
      this.partitionSessions.set(partition, ses)
      this.sessionHook?.(ses, partition)
    }
    const view =
      opts.view ??
      new WebContentsView({
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
    const tab: Tab = {
      id: randomUUID(),
      view,
      profile,
      mobile: opts.mobile ?? false,
      ...(opts.openerId === undefined ? {} : { openerId: opts.openerId })
    }
    this.tabs.push(tab)
    const wc = view.webContents
    this.attachInputHandler(wc)
    this.contextMenuHook?.(wc)
    // 상태 변화 이벤트마다 리스너에 통지 (개별 등록: on() 오버로드가 유니온 리터럴을 받지 않음)
    wc.on('did-start-loading', () => this.emit())
    wc.on('did-stop-loading', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-navigate', () => this.emit())
    // 로드 실패는 원인 파악이 어려우므로 항상 로그로 남긴다(내부 페이지·차단된 주소 진단용)
    // 내부 페이지의 콘솔 오류는 메인 로그로 넘긴다(개발자 도구 없이 진단)
    wc.on('console-message', (ev) => {
      if (ev.level === 'error' && isInternalUrl(wc.getURL())) {
        console.error(`내부 페이지 콘솔: ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
      }
    })
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) console.error(`탭 로드 실패 ${code} ${desc}: ${failedUrl}`)
    })
    wc.on('did-navigate-in-page', () => this.emit())
    // 문서가 바뀔 때마다 제스처 설정을 다시 밀어 준다(preload 는 매 문서마다 새로 뜬다)
    wc.on('dom-ready', () => this.sendGestureConfig(wc))
    // 탭이 실제로 받은 파비콘을 파비콘 서비스 캐시에 넣어 둔다.
    // 이미 열고 있는 페이지에서 나온 정보라 추가로 노출되는 것이 없고,
    // /favicon.ico 가 없는 사이트의 아이콘도 이 경로로 채워진다
    wc.on('page-favicon-updated', (_e, icons) => {
      const iconUrl = icons?.[0]
      if (typeof iconUrl !== 'string') return
      const service = getFaviconService()
      if (!service) return
      // 해당 탭의 세션으로 받아야 쿠키·프록시 설정이 페이지와 같아진다
      void service
        .storeFromPage(
          wc.getURL(),
          iconUrl,
          (url, init) => ses.fetch(url, init) as unknown as Promise<FaviconResponse>
        )
        .catch((e: unknown) => {
          console.warn('파비콘 저장 실패', e instanceof Error ? e.message : String(e))
        })
    })
    guardNavigation(wc, allowExtension)
    // 페이지 JS 대화상자(alert/confirm/prompt)는 작업 실행 중에만 자동으로 닫는다
    installDialogHandler(wc, {
      // SAMBA_E2E 환경변수는 개발 빌드에서만 인정한다(패키징된 앱에서 자동 처리 금지)
      isAutomationActive: () =>
        isAutomationActive(this.agentRunning(), process.env, !app.isPackaged),
      mode: () => this.dialogMode(),
      ...(this.dialogConfirm ? { confirm: this.dialogConfirm } : {}),
      onMessage: (message) => this.lastDialogMessage.set(tab.id, message)
    })
    wc.setWindowOpenHandler(({ url: target }) => {
      if (!isAllowedUrl(target)) {
        console.warn(`새 창 차단: ${target}`)
        return { action: 'deny' }
      }
      // 새 창은 탭 목록에 등록해 스냅샷·조작 대상에 넣는다.
      // 'deny' 하고 URL 만 따로 열면 페이지가 받는 window 참조가 null 이 되어,
      // 결제창처럼 about:blank 팝업을 먼저 열고 폼을 target 으로 보내는 흐름이 통째로 깨진다.
      // 그래서 뷰를 우리가 만들어 돌려주고(createWindow) 그 뷰를 탭으로 등록한다.
      // 팝업은 부모 탭과 같은 profile(세션)을 써야 로그인 세션·쿠키가 이어진다(결제창 필수)
      return {
        action: 'allow',
        // 자식 webContents 는 부모 설정(세션·preload·샌드박스)을 물려받는다. 여기서 덮어써 확실히 한다
        overrideBrowserWindowOptions: {
          webPreferences: {
            session: ses,
            preload: join(__dirname, '../preload/page.js'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        },
        createWindow: (options) => {
          // Electron 이 미리 만들어 넘긴 webContents 로 뷰를 만들어야 한다(다른 것을 만들면 예외)
          // 타입 선언에는 없지만 런타임 options 에는 항상 webContents 가 들어 있다
          const guest = (options as { webContents?: WebContents }).webContents
          const popup = new WebContentsView(guest ? { webContents: guest } : {})
          try {
            this.create({ url: target, profile, mobile: tab.mobile, openerId: tab.id, view: popup })
          } catch (e: unknown) {
            // 등록에 실패해도 뷰는 돌려줘야 페이지의 window.open 이 깨지지 않는다
            console.warn('새 창 등록 실패', e instanceof Error ? e.message : String(e))
          }
          return popup.webContents
        }
      }
    })
    if (tab.mobile) void applyMobileEmulation(wc)
    // 팝업 뷰는 Electron 이 window.open 의 주소를 직접 로드한다
    if (!opts.view) void wc.loadURL(url)
    this.activate(tab.id)
    return this.list().find((t) => t.id === tab.id)!
  }

  activate(id: string): void {
    const tab = this.get(id)
    if (!tab || this.win.isDestroyed()) return
    // 탭 뷰를 다시 얹기 전에 알린다 — 위에 떠 있던 확장 팝업이 탭 뷰 아래로 묻히지 않게
    for (const cb of this.activatedListeners) cb()
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
    this.lastDialogMessage.delete(id)
    // 닫히기 전에 주소를 챙겨 둔다(제스처 '닫은 탭 다시 열기')
    if (!tab.view.webContents.isDestroyed()) {
      const record: ClosedTabRecord = {
        url: tab.view.webContents.getURL(),
        profile: tab.profile,
        mobile: tab.mobile
      }
      for (const cb of this.closedListeners) cb(record)
    }
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
    const url = toUrl(input, this.searchEngine)
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

// 주소창 입력 → URL. 도메인 형태면 https 붙이고, 아니면 검색엔진(기본 구글) 검색
export function toUrl(input: string, engine: SearchEngine = 'google'): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  // 내부 페이지 주소(samba://newtab)는 검색어가 아니라 그대로 연다
  if (isInternalUrl(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  // === 검색엔진 설정 (신규 추가분) ==========================================
  if (engine === 'naver')
    return `https://search.naver.com/search.naver?query=${encodeURIComponent(s)}`
  // === 신규 추가분 끝 =========================================================
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
