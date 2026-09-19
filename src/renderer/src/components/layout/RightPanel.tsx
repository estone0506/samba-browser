import type React from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRightOpen } from 'lucide-react'
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

// 접힌 상태: 얇은 띠에 펼치기 버튼만 둔다(Aside 처럼 한 번에 다시 열기)
export function CollapsedPanelStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const togglePanel = useUiStore((s) => s.togglePanel)
  return (
    <aside className="flex w-10 shrink-0 flex-col items-center pt-12 pr-1">
      <button
        type="button"
        title={t('chat.expandPanel')}
        onClick={() => togglePanel()}
        className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text2)] hover:bg-black/5"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>
    </aside>
  )
}
