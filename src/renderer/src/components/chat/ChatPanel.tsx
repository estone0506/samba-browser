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
import { PanelRightClose } from 'lucide-react'
import { useUiStore } from '@renderer/stores/uiStore'
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
  // 이번 실행에 적용된 플레이북 이름(없으면 줄 자체가 뜨지 않는다)
  const playbookNames = useChatStore((s) => s.playbookNames)
  const togglePanel = useUiStore((s) => s.togglePanel)
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
      {/* 플레이북 적용 안내 한 줄 — 어떤 절차를 따르는지 사용자가 바로 알 수 있게 한다 */}
      {playbookNames.length > 0 && (
        <div className="border-b border-black/5 px-3.5 py-2 text-[11.5px] text-[var(--text2)]">
          <span className="inline-flex h-[20px] items-center rounded-full border border-[var(--text)] bg-[var(--text)] px-2 font-medium text-white">
            {t('automation.appliedBadge')}
          </span>
          <span className="ml-2">
            {t('automation.applied', { names: playbookNames.join(', ') })}
          </span>
        </div>
      )}
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
