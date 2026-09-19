import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chatStore'
import { useUiStore } from '@renderer/stores/uiStore'
import type { ChatDto } from '@shared/ipc'

/** 삭제 × 를 한 번 누르고 이 시간 안에 다시 누르지 않으면 저절로 취소된다(ItemList 와 같은 규칙) */
const DELETE_CONFIRM_MS = 2000

export function ChatList(): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const chats = useChatStore((s) => s.chats)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const loadChats = useChatStore((s) => s.loadChats)
  const openChat = useChatStore((s) => s.openChat)
  const newChat = useChatStore((s) => s.newChat)
  const removeChat = useChatStore((s) => s.removeChat)

  // 앱이 뜨면 최근 대화를 한 번 읽어 온다
  useEffect(() => {
    void loadChats()
  }, [loadChats])

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          newChat()
          setView('browser')
        }}
        className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('chat.new')}
      </button>
      {chats.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-[var(--text3)]">{t('chat.empty')}</div>
      ) : (
        <ul className="flex flex-col">
          {chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === activeChatId}
              onOpen={() => {
                void openChat(chat.id)
                setView('browser')
              }}
              onDelete={() => void removeChat(chat.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ChatRow({
  chat,
  active,
  onOpen,
  onDelete
}: {
  chat: ChatDto
  active: boolean
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 되돌릴 수 없는 삭제라 확인 없이 지우지 않는다 — 2초 안의 두 번째 클릭이 확인이다
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), DELETE_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <li className="group relative flex items-center">
      <button
        type="button"
        onClick={onOpen}
        title={chat.title || t('chat.untitled')}
        className={cn(
          'min-w-0 flex-1 truncate rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5',
          active && 'bg-black/5 font-medium text-[var(--text)]'
        )}
      >
        {chat.title || t('chat.untitled')}
      </button>
      {confirming ? (
        <button
          type="button"
          onClick={() => {
            setConfirming(false)
            onDelete()
          }}
          className="absolute right-1 rounded-[7px] bg-[#ff3b30] px-2 py-0.5 text-[11px] font-medium text-white"
        >
          {t('chat.deleteConfirm')}
        </button>
      ) : (
        <button
          type="button"
          aria-label={t('chat.delete')}
          title={t('chat.delete')}
          onClick={() => setConfirming(true)}
          className="absolute right-1 hidden rounded-[7px] p-1 text-[var(--text3)] hover:bg-black/5 hover:text-[var(--text)] group-hover:block"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  )
}
