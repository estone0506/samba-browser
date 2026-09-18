import type React from 'react'
import { ChatPanel } from '@renderer/components/chat/ChatPanel'
import { VaultPopover } from '@renderer/components/vault/VaultPopover'
import { useUiStore } from '@renderer/stores/uiStore'

export function RightPanel({ width }: { width: number }): React.JSX.Element {
  // 툴바 열쇠 아이콘으로 여는 키마스터 패널. 웹뷰(네이티브 뷰) 밖인 이 패널 상단 슬롯에
  // 그려야 팝오버가 웹페이지에 가려지지 않는다
  const vaultPanelOpen = useUiStore((s) => s.vaultPanelOpen)
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col gap-2.5 pr-2.5 pt-10">
      {vaultPanelOpen && <VaultPopover />}
      <ChatPanel />
    </aside>
  )
}
