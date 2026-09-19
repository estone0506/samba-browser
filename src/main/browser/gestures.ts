// 마우스 제스처 실행(메인 프로세스).
//
// 페이지 preload 가 인식한 방향 시퀀스(page:gesture)를 받아 설정의 매핑대로 동작을 실행한다.
// TabManager·BrowserWindow 를 직접 참조하지 않고 좁은 의존성 묶음만 받으므로
// 테스트에서는 스텁으로 전부 대체할 수 있다.

import { resolveGestureAction, type GestureAction } from '../../shared/gestures'

/** 닫은 탭 다시 열기용 스택 상한 */
export const CLOSED_TAB_LIMIT = 10

/** 다시 열 때 필요한 최소한의 탭 정보 */
export interface ClosedTabRecord {
  url: string
  profile: string
  mobile: boolean
}

/** 최근 닫힌 탭 스택(최대 10). 오래된 것부터 밀려난다 */
export class ClosedTabStack {
  private items: ClosedTabRecord[] = []

  push(tab: ClosedTabRecord): void {
    // 빈 탭은 되살릴 의미가 없다
    if (!tab.url || tab.url === 'about:blank') return
    this.items.push(tab)
    if (this.items.length > CLOSED_TAB_LIMIT) this.items.shift()
  }

  pop(): ClosedTabRecord | null {
    return this.items.pop() ?? null
  }

  size(): number {
    return this.items.length
  }

  list(): readonly ClosedTabRecord[] {
    return this.items
  }
}

/**
 * 동작 실행에 필요한 것들. 전부 함수라 테스트에서 호출 기록만 보면 된다.
 * (탭 조작은 TabManager, 창 조작은 BrowserWindow 가 실제 구현이다)
 */
export interface GestureDeps {
  /** 제스처를 보낸 탭 id. 없으면 탭 관련 동작은 조용히 넘긴다 */
  activeTabId: () => string | null
  back: (tabId: string) => void
  forward: (tabId: string) => void
  reload: (tabId: string) => void
  navigate: (tabId: string, url: string) => Promise<void>
  /** 페이지를 맨 위·맨 아래로 보낸다 */
  scrollTo: (tabId: string, to: 'top' | 'bottom') => Promise<void>
  homeUrl: () => string
  newTab: () => void
  /** 단일 창 구조라 실제 창 대신 새 탭을 연다(라벨에도 그렇게 적혀 있다) */
  newWindow: () => void
  /** 시크릿창 대체 — 새 프로필(세션 분리) 탭 */
  newProfileTab: () => void
  closeTab: (tabId: string) => void
  reopenTab: () => void
  toggleFullScreen: () => void
  maximize: () => void
  minimize: () => void
}

/**
 * 시퀀스를 동작으로 바꿔 실행하고, 실제로 실행한 동작을 돌려준다.
 * 실행할 것이 없으면 'none' 이다
 */
export async function runGesture(
  sequence: string,
  mapping: Record<string, GestureAction | string>,
  deps: GestureDeps
): Promise<GestureAction> {
  const action = resolveGestureAction(sequence, mapping)
  if (action === 'none') return 'none'
  const tabId = deps.activeTabId()

  switch (action) {
    case 'back':
      if (tabId) deps.back(tabId)
      break
    case 'forward':
      if (tabId) deps.forward(tabId)
      break
    case 'reload':
      if (tabId) deps.reload(tabId)
      break
    case 'home':
      if (tabId) await deps.navigate(tabId, deps.homeUrl())
      break
    case 'scrollTop':
      if (tabId) await deps.scrollTo(tabId, 'top')
      break
    case 'scrollBottom':
      if (tabId) await deps.scrollTo(tabId, 'bottom')
      break
    case 'newTab':
      deps.newTab()
      break
    case 'newWindow':
      deps.newWindow()
      break
    case 'newProfileTab':
      deps.newProfileTab()
      break
    case 'closeTab':
      if (tabId) deps.closeTab(tabId)
      break
    case 'reopenTab':
      deps.reopenTab()
      break
    case 'fullscreen':
      deps.toggleFullScreen()
      break
    case 'maximize':
      deps.maximize()
      break
    case 'minimize':
      deps.minimize()
      break
  }
  return action
}

/** 새 프로필 탭에 쓸 파티션 이름. 열 때마다 새 세션이 되도록 시각을 붙인다 */
export function newProfileName(now: number): string {
  return `guest-${now}`
}
