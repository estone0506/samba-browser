import type React from 'react'
import { ChatPanel } from '@renderer/components/chat/ChatPanel'

export function RightPanel({ width }: { width: number }): React.JSX.Element {
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col gap-2.5 pr-2.5 pt-10">
      <ChatPanel />
    </aside>
  )
}
