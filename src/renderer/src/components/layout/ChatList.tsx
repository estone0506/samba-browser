import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chatStore'
import { useUiStore } from '@renderer/stores/uiStore'
import type { ChatDto } from '@shared/ipc'

export function ChatList(): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const chats = useChatStore((s) => s.chats)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const loadChats = useChatStore((s) => s.loadChats)
  const openChat = useChatStore((s) => s.openChat)
  const newChat = useChatStore((s) => s.newChat)
  const removeChat = useChatStore((s) => s.removeChat)
  // 실행 중에는 다른 대화로 옮기지 못한다(화면의 메시지가 돌고 있는 작업에 묶여 있다).
  // 말없이 무반응이면 고장처럼 보이므로 흐리게 하고 이유를 알려 준다
  const locked = useChatStore((s) => s.status === 'running')

  // 앱이 뜨면 최근 대화를 한 번 읽어 온다
  useEffect(() => {
    void loadChats()
  }, [loadChats])

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={locked}
        title={locked ? t('chat.lockedWhileRunning') : undefined}
        onClick={() => {
          newChat()
          setView('browser')
        }}
        className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
              locked={locked && chat.id !== activeChatId}
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
  locked,
  onOpen,
  onDelete
}: {
  chat: ChatDto
  active: boolean
  /** 실행 중이라 이 대화로 옮길 수 없다 */
  locked: boolean
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li className="group relative flex items-center">
      <button
        type="button"
        onClick={onOpen}
        disabled={locked}
        title={locked ? t('chat.lockedWhileRunning') : chat.title || t('chat.untitled')}
        className={cn(
          'min-w-0 flex-1 truncate rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          active && 'bg-black/5 font-medium text-[var(--text)]'
        )}
      >
        {chat.title || t('chat.untitled')}
      </button>
      {/* 탭의 X 처럼 확인 없이 바로 지운다(사용자 요청) */}
      <button
        type="button"
        aria-label={t('chat.delete')}
        title={t('chat.delete')}
        onClick={onDelete}
        className="absolute right-1 hidden rounded-[7px] p-1 text-[var(--text3)] hover:bg-black/5 hover:text-[var(--text)] group-hover:block"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
