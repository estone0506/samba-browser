// 확장 액션 팝업 — 크롬에서 툴바 아이콘을 누르면 뜨는 그 작은 창이다.
//
// 렌더러 팝오버로는 만들 수 없다. 팝업 안에서 chrome.storage·chrome.runtime 이 돌아야 하는데,
// 그건 `chrome-extension://<id>/` 출처의 진짜 문서에서만 가능하기 때문이다.
// 그래서 탭과 같은 종류의 네이티브 WebContentsView 를 하나 더 띄우고, 탭 뷰 위에 얹는다
// (네이티브 뷰는 항상 렌더러 위에 그려지므로 웹뷰를 접는 정지 이미지 처리가 필요 없다).
//
// 세션은 반드시 그 확장이 로드된 탭 세션(파티션)과 같아야 한다 — 다른 세션에서 열면
// 확장이 로드돼 있지 않아 문서 자체가 열리지 않는다.

import { WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { ExtensionAnchorDto } from '../../shared/extensions'
import {
  clampPopupSize,
  popupBounds,
  POPUP_DEFAULT_HEIGHT,
  POPUP_DEFAULT_WIDTH,
  type PopupSize
} from './action'

export interface ExtensionPopupOpenInput {
  /** 어떤 확장의 팝업인지 — 같은 확장을 다시 누르면 닫는다(크롬과 같은 토글) */
  id: string
  url: string
  session: Session
  anchor: ExtensionAnchorDto
}

export interface ExtensionPopupDeps {
  win: BrowserWindow
  /** 팝업이 닫힐 때 렌더러에 알린다(툴바 버튼의 눌림 표시를 되돌리기 위해) */
  onClosed: () => void
}

/**
 * 확장 문서를 열 수 있는 세션을 고른다.
 *
 * 팝업은 그 확장이 실제로 로드된 세션에서만 열린다 — 아니면 크로미움이 문서 자체를
 * ERR_BLOCKED_BY_CLIENT 로 막는다. 보통은 지금 보고 있는 탭의 파티션 세션이지만,
 * 그 세션에 붙이는 데 실패했을 수 있으므로 확장이 실제로 있는 세션을 확인해서 고른다
 */
export function sessionWithExtension(id: string, candidates: readonly Session[]): Session | null {
  for (const ses of candidates) {
    try {
      if (ses.extensions.getExtension(id)) return ses
    } catch {
      // 이 세션에서 확장 목록을 못 읽으면 다음 후보로 넘어간다
    }
  }
  return null
}

/**
 * 팝업이 머물러도 되는 주소인가 — 그 확장 자신의 `chrome-extension://<id>/` 문서뿐이다.
 * 팝업 문서가 http(s)·file 로 넘어가면 확장 권한을 가진 창에서 남의 페이지가 도는 셈이 된다
 */
export function isOwnExtensionUrl(url: string, id: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'chrome-extension:' && u.hostname === id
  } catch {
    return false
  }
}

/** 창 하나가 가진 팝업은 언제나 최대 한 개다 */
export class ExtensionPopupHost {
  private view: WebContentsView | null = null
  private openId: string | null = null
  private anchor: ExtensionAnchorDto | null = null
  private size: PopupSize = { width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT }
  private disposed = false

  constructor(private readonly deps: ExtensionPopupDeps) {
    // 창 크기가 바뀌면 버튼도 같이 움직이므로 팝업 위치를 다시 맞춘다
    deps.win.on('resize', () => this.applyBounds())
  }

  /** 지금 팝업이 떠 있는 확장 id(없으면 null) */
  activeId(): string | null {
    return this.openId
  }

  /** 이 webContents 가 지금 떠 있는 팝업인가(팝업이 보내는 IPC 의 발신자 검증) */
  isPopupSender(wc: WebContents): boolean {
    return (
      this.view !== null && !this.view.webContents.isDestroyed() && this.view.webContents === wc
    )
  }

  /**
   * 같은 확장이 이미 떠 있으면 닫고, 아니면 연다.
   * 돌려주는 값은 "연 뒤에 팝업이 떠 있는가" 다
   */
  toggle(input: ExtensionPopupOpenInput): boolean {
    if (this.openId === input.id) {
      this.close()
      return false
    }
    this.open(input)
    return true
  }

  private open(input: ExtensionPopupOpenInput): void {
    if (this.disposed || this.deps.win.isDestroyed()) return
    this.close()
    // 팝업은 확장 문서이지 웹페이지가 아니다 — 우리 페이지 preload 를 넣지 않는다.
    // (넣으면 제스처·번역 훅이 확장 UI 위에서 돌아 크롬과 다르게 동작한다)
    const view = new WebContentsView({
      webPreferences: {
        session: input.session,
        sandbox: true,
        contextIsolation: true,
        // 크롬과 같은 자동 크기의 핵심 — 이 옵션을 켜야 문서가 원하는 크기를
        // `preferred-size-changed` 로 알려 온다(그 값을 800×600 안에서 잘라 쓴다)
        enablePreferredSizeMode: true
      }
    })
    view.setBorderRadius(0)
    this.view = view
    this.openId = input.id
    this.anchor = input.anchor
    this.size = { width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT }
    const wc = view.webContents
    // 팝업은 그 확장의 문서 안에서만 움직인다. 바깥 주소로 넘어가려 하면 막는다 —
    // 팝업 창은 탭과 달리 주소 표시줄이 없어 사용자가 어디에 있는지 알 수 없고,
    // 확장 세션 안에서 남의 페이지가 도는 것을 그대로 두면 안 된다
    const guard = (e: { preventDefault: () => void }, url: string, what: string): void => {
      if (isOwnExtensionUrl(url, input.id)) return
      e.preventDefault()
      console.warn(`확장 팝업 ${what} 차단: ${url}`)
    }
    wc.on('will-navigate', (e, url) => guard(e, url, '이동'))
    wc.on('will-redirect', (e, url) => guard(e, url, '리다이렉트'))
    // 팝업이 여는 새 창은 만들지 않는다(크롬도 팝업에서 뜬 창은 탭으로 보낸다).
    // 여기서 허용하면 가드 없는 창이 확장 세션으로 열린다
    wc.setWindowOpenHandler(({ url }) => {
      console.warn(`확장 팝업 새 창 차단: ${url}`)
      return { action: 'deny' }
    })
    // 문서가 원하는 크기를 알려 오면 그 값으로 창을 맞춘다.
    // 신호가 오지 않는 문서라면 기본 크기(360×420)로 그대로 떠 있는다
    wc.on('preferred-size-changed', (_e, preferred) => {
      this.setSize(preferred.width, preferred.height)
    })
    // 팝업 밖(웹페이지·앱 UI)을 누르면 포커스를 잃는다 — 크롬처럼 그때 닫는다.
    // 다만 한 번이라도 포커스를 받은 뒤에만 닫는다. 창이 뒤에 있어 포커스를 못 받는
    // 상황에서 blur 가 먼저 오면, 뜨자마자 닫혀 아무 일도 안 한 것처럼 보이기 때문이다
    let focused = false
    wc.on('focus', () => {
      focused = true
    })
    wc.on('blur', () => {
      if (focused) this.close()
    })
    wc.on('before-input-event', (_e, input2) => {
      if (input2.type === 'keyDown' && input2.key === 'Escape') this.close()
    })
    wc.on('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.focus()
    })
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        console.error(`확장 팝업 로드 실패 ${code} ${desc}: ${failedUrl}`)
      }
    })
    this.deps.win.contentView.addChildView(view)
    this.applyBounds()
    void wc.loadURL(input.url)
  }

  /** 문서가 알려 온 선호 크기를 반영한다(상한 800×600 에서 자른다) */
  setSize(width: unknown, height: unknown): void {
    if (!this.view) return
    this.size = clampPopupSize(width, height)
    this.applyBounds()
  }

  private applyBounds(): void {
    if (!this.view || !this.anchor || this.deps.win.isDestroyed()) return
    const [w, h] = this.deps.win.getContentSize()
    this.view.setBounds(popupBounds(this.anchor, this.size, w, h))
  }

  /** 팝업을 닫는다. 이미 닫혀 있으면 아무 일도 하지 않는다(멱등) */
  close(): void {
    const view = this.view
    if (!view) return
    this.view = null
    this.openId = null
    this.anchor = null
    if (!this.deps.win.isDestroyed()) this.deps.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    if (!this.disposed) this.deps.onClosed()
  }

  /** 창이 닫힐 때 — 더 이상 렌더러에 알리지 않는다 */
  dispose(): void {
    this.disposed = true
    this.close()
  }
}
