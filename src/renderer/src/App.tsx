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
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useChatStore } from '@renderer/stores/chatStore'

export default function App(): React.JSX.Element {
  const { t } = useTranslation()
  const { refresh, setTabs } = useBrowserStore()
  const { sidebarWidth, panelWidth, view } = useUiStore()
  const chat = useChatStore()
  useEffect(() => {
    void refresh()
    return window.samba.tabs.onUpdated(setTabs)
  }, [refresh, setTabs])
  // browser 뷰가 아닐 때는 네이티브 웹뷰(WebContentsView)가 렌더러 위를 덮지 않도록
  // bounds 를 0 으로 접는다. WebArea 는 마운트될 때 다시 자기 크기를 보고하므로
  // browser 뷰로 돌아오면 자동으로 재측정된다.
  // useLayoutEffect 로 페인트 전에 접어서, 뷰 전환 시 네이티브 뷰가 새 렌더러 콘텐츠 위에
  // 한 프레임 겹쳐 보이는 현상을 없앤다
  useLayoutEffect(() => {
    if (view !== 'browser') void window.samba.layout.set({ x: 0, y: 0, width: 0, height: 0 })
  }, [view])
  return (
    <div className="flex h-full bg-[var(--bg)]">
      <Sidebar width={sidebarWidth} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col py-2.5 pr-2.5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
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
          ) : (
            <PersonalInfoPage />
          )}
        </div>
      </main>
      <RightPanel width={panelWidth} />
    </div>
  )
}
