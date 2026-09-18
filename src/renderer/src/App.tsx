import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from '@renderer/components/layout/Sidebar'
import { RightPanel } from '@renderer/components/layout/RightPanel'
import { TabBar } from '@renderer/components/browser/TabBar'
import { AddressBar } from '@renderer/components/browser/AddressBar'
import { ProgressBar } from '@renderer/components/browser/ProgressBar'
import { WebArea } from '@renderer/components/browser/WebArea'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useChatStore } from '@renderer/stores/chatStore'

export default function App(): React.JSX.Element {
  const { t } = useTranslation()
  const { refresh, setTabs } = useBrowserStore()
  const { sidebarWidth, panelWidth } = useUiStore()
  const chat = useChatStore()
  useEffect(() => {
    void refresh()
    return window.samba.tabs.onUpdated(setTabs)
  }, [refresh, setTabs])
  return (
    <div className="flex h-full bg-[var(--bg)]">
      <Sidebar width={sidebarWidth} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col py-2.5 pr-2.5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
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
        </div>
      </main>
      <RightPanel width={panelWidth} />
    </div>
  )
}
