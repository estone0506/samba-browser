import type React from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ConfirmCard } from './ConfirmCard'
import { HandoffCard } from './HandoffCard'
import { AuthBanner } from './AuthBanner'
import { PanelRightClose } from 'lucide-react'
import { useUiStore } from '@renderer/stores/uiStore'
import { CapturePrompt } from '@renderer/components/vault/CapturePrompt'
import { PasswordUpdatedToast } from '@renderer/components/vault/PasswordUpdatedToast'

export function ChatPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const handleEvent = useChatStore((s) => s.handleEvent)
  const togglePanel = useUiStore((s) => s.togglePanel)
  useEffect(() => window.samba.agent.onEvent(handleEvent), [handleEvent])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
      <div className="flex items-center justify-between border-b border-black/5 px-3.5 py-3 font-semibold">
        {t('chat.title')}
        <span className="flex items-center gap-2 text-[12px] font-normal text-[var(--text2)]">
          <span className="h-[7px] w-[7px] rounded-full bg-[var(--ok)]" />
          {t('chat.provider')}
          <button
            type="button"
            title={t('chat.collapsePanel')}
            onClick={() => togglePanel()}
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text3)] hover:bg-black/5 hover:text-[var(--text)]"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </span>
      </div>
      <AuthBanner />
      {/* 자동 저장 제안 카드 · 자동 갱신 토스트는 메시지 목록 맨 위에 고정한다 */}
      <CapturePrompt />
      <PasswordUpdatedToast />
      <MessageList />
      <HandoffCard />
      <ConfirmCard />
      <ChatInput />
    </div>
  )
}
