import type React from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ConfirmCard } from './ConfirmCard'
import { AuthBanner } from './AuthBanner'

export function ChatPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const handleEvent = useChatStore((s) => s.handleEvent)
  useEffect(() => window.samba.agent.onEvent(handleEvent), [handleEvent])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
      <div className="flex items-center justify-between border-b border-black/5 px-3.5 py-3 font-semibold">
        {t('chat.title')}
        <span className="flex items-center gap-1.5 text-[12px] font-normal text-[var(--text2)]">
          <span className="h-[7px] w-[7px] rounded-full bg-[var(--ok)]" />
          {t('chat.provider')}
        </span>
      </div>
      <AuthBanner />
      <MessageList />
      <ConfirmCard />
      <ChatInput />
    </div>
  )
}
