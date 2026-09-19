// window.open 으로 열린 팝업 창(결제창·인증창)의 수명주기.
//
// tab-manager 에서 떼어 둔 이유는 Electron 의 BrowserWindow 없이 테스트하기 위해서다.
// 여기서는 창을 다루는 최소 동작(PopupHandle)만 받고, 실제 BrowserWindow 를
// 그 모양으로 감싸는 일은 tab-manager 가 한다.
//
// 안전 규칙
//  - 앱이 종료되는 중에는 close 를 미루지 않는다. 미루면(preventDefault) app.quit() 이
//    통째로 취소되고, before-quit 에서 이미 DB·금고를 닫아 둔 좀비 앱이 남는다
//  - 창이 사라질 때(dispose) 남은 팝업은 전부 파괴한다 — 추적만 지우면 결제창이
//    떠 있는 채로 부모 없이 남는다

/** 팝업 창이 스스로 닫힐 때 실제 파괴를 미루는 시간 */
export const POPUP_CLOSE_DELAY_MS = 2500

/** 팝업 창 하나를 다루는 데 필요한 최소 동작 */
export interface PopupHandle {
  isDestroyed: () => boolean
  hide: () => void
  close: () => void
  destroy: () => void
}

/** 추적 중인 팝업 한 건. win 은 소비자(tab-manager)가 쓰는 원본 창이다 */
export interface PopupEntry<W> {
  id: string
  win: W
  openerId: string
  profile: string
  handle: PopupHandle
  /** 이미 한 번 지연 처리했는가(두 번째 close 는 그대로 닫는다) */
  deferred: boolean
}

// --- 앱 종료 표식 ------------------------------------------------------------
// before-quit 이 걸리면 index.ts 가 가장 먼저 이 표식을 세운다.
// 모듈 전역으로 두는 이유는 창마다 있는 TabManager 전부가 같은 답을 봐야 하기 때문이다
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/** 테스트 전용 초기화(운영 코드에서는 부르지 않는다) */
export function resetQuitting(): void {
  quitting = false
}

export interface PopupRegistryOptions {
  /** 앱이 종료되는 중인가. 기본값은 모듈 전역 표식 */
  quitting?: () => boolean
  /** 지연 파괴 예약. 테스트는 즉시 실행하는 가짜를 넣는다 */
  schedule?: (fn: () => void, ms: number) => void
}

export class PopupRegistry<W> {
  private entries: PopupEntry<W>[] = []
  private destroyed = false
  private readonly quitting: () => boolean
  private readonly schedule: (fn: () => void, ms: number) => void

  constructor(options: PopupRegistryOptions = {}) {
    this.quitting = options.quitting ?? isQuitting
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms)
      })
  }

  /** 추적 목록에 넣는다. 창이 닫히면 호출부가 remove 를 불러 준다 */
  add(entry: Omit<PopupEntry<W>, 'deferred'>): PopupEntry<W> {
    const item: PopupEntry<W> = { ...entry, deferred: false }
    this.entries.push(item)
    return item
  }

  remove(entry: PopupEntry<W>): void {
    this.entries = this.entries.filter((p) => p !== entry)
  }

  /** 아직 살아 있는 팝업만 */
  alive(): PopupEntry<W>[] {
    return this.entries.filter((p) => !p.handle.isDestroyed())
  }

  /** 살아 있는 팝업 중 조건에 맞는 첫 번째 */
  find(match: (entry: PopupEntry<W>) => boolean): PopupEntry<W> | null {
    return this.alive().find(match) ?? null
  }

  /** 이 탭이 띄운 팝업 중 아직 살아 있는 가장 최근 것 */
  latestFor(openerId: string): PopupEntry<W> | null {
    const alive = this.alive()
    for (let i = alive.length - 1; i >= 0; i--) {
      if (alive[i].openerId === openerId) return alive[i]
    }
    return null
  }

  /**
   * 팝업 창의 'close' 이벤트 처리.
   *
   * 팝업이 스스로 닫히는(window.close) 순간 부모 탭이 결제 처리 주소로 이동하면
   * 브라우저 프로세스가 죽는 크래시가 있었다. 그래서 창은 즉시 숨기고 실제 파괴는
   * 잠시 뒤로 미룬다. 다만 앱 종료 중에는 미루지 않는다 — preventDefault 가
   * app.quit() 자체를 취소해 버리기 때문이다
   */
  handleClose(entry: PopupEntry<W>, preventDefault: () => void): void {
    if (this.destroyed || entry.deferred) return
    if (this.quitting() || entry.handle.isDestroyed()) return
    preventDefault()
    entry.deferred = true
    entry.handle.hide()
    this.schedule(() => {
      if (!entry.handle.isDestroyed()) entry.handle.close()
    }, POPUP_CLOSE_DELAY_MS)
  }

  /** 창이 사라질 때 남은 팝업을 모두 파괴한다(멱등) */
  destroyAll(): void {
    this.destroyed = true
    const items = this.entries
    this.entries = []
    for (const entry of items) {
      // 남아 있는 지연 타이머가 파괴된 창을 다시 닫지 않게 표식을 올려 둔다
      entry.deferred = true
      if (!entry.handle.isDestroyed()) entry.handle.destroy()
    }
  }
}
