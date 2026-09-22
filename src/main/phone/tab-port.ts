// 폰 배선이 웹 페이지에 닿는 어댑터. wiring.ts 를 탭·page-bridge 에서 떼어 놓기 위해
// 이 파일 하나만 TabManager 를 안다(테스트는 PagePort 를 가짜로 넣는다)

import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { normalizeHost } from '../../shared/host'
import type { PageSnapshot } from '../../shared/snapshot'
import { isPaySuccessUrl, PAY_SUCCESS_TEXT_RE, type PagePort } from './wiring'

const EMPTY_SNAPSHOT: PageSnapshot = { url: '', title: '', text: '', elements: [] }

/** 활성 탭이 없을 때도 던지지 않는다 — 인증 흐름이 'no-field' 로 조용히 끝난다 */
export function createTabPagePort(tabs: TabManager): PagePort {
  const active = (): ReturnType<TabManager['active']> => tabs.active()

  return {
    host: () => {
      const tab = active()
      return tab ? normalizeHost(tab.view.webContents.getURL()) : ''
    },
    profile: () => active()?.profile ?? '',
    activeTabId: () => active()?.id ?? null,
    snapshot: async () => {
      const tab = active()
      return tab ? pageBridge.snapshot(tab) : EMPTY_SNAPSHOT
    },
    fillValue: async (elementId, value) => {
      const tab = active()
      return tab ? pageBridge.fillValue(tab, elementId, value) : 'not found'
    },
    submit: async (elementId) => {
      const tab = active()
      return tab ? pageBridge.submitForm(tab, elementId) : 'not found'
    },
    paymentSucceeded: async (openerId) => {
      // 결제창은 보통 팝업이다. 팝업이 닫혔으면 원래 탭이 성공 주소로 돌아온다
      const target = (openerId === null ? null : tabs.popupOf(openerId)) ?? active()
      if (!target) return false
      if (isPaySuccessUrl(target.view.webContents.getURL())) return true
      try {
        return PAY_SUCCESS_TEXT_RE.test((await pageBridge.snapshot(target)).text)
      } catch {
        // 팝업이 막 닫히는 중이면 스냅샷이 실패한다 — 아직 성공으로 보지 않는다
        return false
      }
    }
  }
}
