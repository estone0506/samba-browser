import { useEffect } from 'react'
import type React from 'react'
import { Sidebar } from '@renderer/components/layout/Sidebar'
import { RightPanel } from '@renderer/components/layout/RightPanel'
import { TabBar } from '@renderer/components/browser/TabBar'
import { AddressBar } from '@renderer/components/browser/AddressBar'
import { WebArea } from '@renderer/components/browser/WebArea'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'

export default function App(): React.JSX.Element {
  const { refresh, setTabs } = useBrowserStore()
  const { sidebarWidth, panelWidth } = useUiStore()
  useEffect(() => {
    void refresh()
    return window.samba.tabs.onUpdated(setTabs)
  }, [refresh, setTabs])
  return (
    <div className="flex h-full bg-[var(--bg)]">
      <Sidebar width={sidebarWidth} />
      <main className="flex min-w-0 flex-1 flex-col py-2.5 pr-2.5">
        <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
          <TabBar />
          <AddressBar />
          <WebArea />
        </div>
      </main>
      <RightPanel width={panelWidth} />
    </div>
  )
}
