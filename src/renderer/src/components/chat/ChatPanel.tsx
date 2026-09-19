import type React from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'
import { useAiStore } from '@renderer/stores/aiStore'
import type { AiProviderId } from '@shared/ai'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ConfirmCard } from './ConfirmCard'
import { HandoffCard } from './HandoffCard'
import { AuthBanner } from './AuthBanner'
import { CapturePrompt } from '@renderer/components/vault/CapturePrompt'
import { PasswordUpdatedToast } from '@renderer/components/vault/PasswordUpdatedToast'

// 배지에 쓸 제공자 이름 키
const PROVIDER_LABEL_KEYS: Record<AiProviderId, string> = {
  claude_subscription: 'settings.ai.claudeSubscription',
  codex_subscription: 'settings.ai.codexSubscription',
  api_key: 'settings.ai.apiKey',
  service_credit: 'settings.ai.serviceCredit'
}

export function ChatPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const handleEvent = useChatStore((s) => s.handleEvent)
  useEffect(() => window.samba.agent.onEvent(handleEvent), [handleEvent])
  // 상단 배지는 지금 고른 경로와 **실제 연결 상태**를 그대로 비춘다
  const provider = useAiStore((s) => s.provider)
  const providers = useAiStore((s) => s.providers)
  const loadAi = useAiStore((s) => s.load)
  useEffect(() => {
    void loadAi()
  }, [loadAi])
  const status = providers.find((p) => p.id === provider)
  // 구독 카드는 connected 일 때만, 내 API 키는 키가 있을 때만 쓸 수 있다
  const usable = status?.state === 'connected'
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
      <div className="flex items-center justify-between border-b border-black/5 px-3.5 py-3 font-semibold">
        {t('chat.title')}
        <span className="flex items-center gap-1.5 text-[12px] font-normal text-[var(--text2)]">
          <span
            className={
              usable
                ? 'h-[7px] w-[7px] rounded-full bg-[var(--ok)]'
                : 'h-[7px] w-[7px] rounded-full bg-[var(--text2)]/40'
            }
          />
          {t(PROVIDER_LABEL_KEYS[provider])}
          {!usable && ` · ${t('settings.ai.notConnectedShort')}`}
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
