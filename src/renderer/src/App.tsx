import { useEffect, useLayoutEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from '@renderer/components/layout/Sidebar'
import { RightPanel } from '@renderer/components/layout/RightPanel'
import { TabBar } from '@renderer/components/browser/TabBar'
import { AddressBar } from '@renderer/components/browser/AddressBar'
import { ProgressBar } from '@renderer/components/browser/ProgressBar'
import { WebArea } from '@renderer/components/browser/WebArea'
import { PersonalInfoPage } from '@renderer/pages/PersonalInfoPage'
import { BookmarksPage } from '@renderer/pages/BookmarksPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useChatStore } from '@renderer/stores/chatStore'
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle'
import { useVaultStore } from '@renderer/stores/vaultStore'

export default function App(): React.JSX.Element {
  const { t } = useTranslation()
  const { refresh, setTabs } = useBrowserStore()
  const { sidebarWidth, panelWidth, view, setSidebarWidth, setPanelWidth } = useUiStore()
  const chat = useChatStore()
  const refreshVaultState = useVaultStore((s) => s.refreshState)
  const subscribeCapture = useVaultStore((s) => s.subscribeCapture)
  const subscribePasswordUpdated = useVaultStore((s) => s.subscribePasswordUpdated)
  useEffect(() => {
    void refresh()
    return window.samba.tabs.onUpdated(setTabs)
  }, [refresh, setTabs])
  // 저장된 패널 폭 복원(기기별 설정)
  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setSidebarWidth(r.data.sidebarWidth)
      setPanelWidth(r.data.panelWidth)
    })
  }, [setSidebarWidth, setPanelWidth])
  // 자동 저장 제안 카드(vault:capturePrompt) · 자동 갱신 토스트(vault:passwordUpdated) 구독은
  // 앱 전체에서 한 번만 한다
  useEffect(() => {
    void refreshVaultState()
    subscribeCapture()
    subscribePasswordUpdated()
  }, [refreshVaultState, subscribeCapture, subscribePasswordUpdated])
  // browser 뷰가 아닐 때는 네이티브 웹뷰(WebContentsView)가 렌더러 위를 덮지 않도록
  // bounds 를 0 으로 접는다. WebArea 는 마운트될 때 다시 자기 크기를 보고하므로
  // browser 뷰로 돌아오면 자동으로 재측정된다.
  // useLayoutEffect 로 페인트 전에 접어서, 뷰 전환 시 네이티브 뷰가 새 렌더러 콘텐츠 위에
  // 한 프레임 겹쳐 보이는 현상을 없앤다
  useLayoutEffect(() => {
    if (view !== 'browser')
      void window.samba.layout.set({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
  }, [view])
  return (
    <div className="flex h-full bg-[var(--bg)]">
      <Sidebar width={sidebarWidth} />
      <ResizeHandle
        side="right"
        getWidth={() => useUiStore.getState().sidebarWidth}
        onWidth={setSidebarWidth}
        onEnd={() =>
          void window.samba.settings.set({ sidebarWidth: useUiStore.getState().sidebarWidth })
        }
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-2.5 pr-2.5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
          {view === 'browser' ? (
            <>
              <TabBar />
              <AddressBar />
              <ProgressBar
                running={chat.status === 'running'}
                label={
                  chat.retry
                    ? t('chat.apiRetry', { n: chat.retry.attempt, reason: chat.retry.reason })
                    : chat.currentLabel || t('chat.thinking')
                }
                toolCalls={chat.toolCalls}
                max={40}
                onStop={() => void chat.stop()}
              />
              <WebArea />
            </>
          ) : view === 'bookmarks' ? (
            <BookmarksPage />
          ) : view === 'settings' ? (
            <SettingsPage />
          ) : (
            <PersonalInfoPage />
          )}
        </div>
      </main>
      <ResizeHandle
        side="left"
        getWidth={() => useUiStore.getState().panelWidth}
        onWidth={setPanelWidth}
        onEnd={() =>
          void window.samba.settings.set({ panelWidth: useUiStore.getState().panelWidth })
        }
      />
      <RightPanel width={panelWidth} />
    </div>
  )
}
