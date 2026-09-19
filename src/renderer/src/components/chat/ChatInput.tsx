import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp } from 'lucide-react'
import { useChatStore } from '@renderer/stores/chatStore'
import { PermissionMenu } from './PermissionMenu'
import { ModelEffortMenu } from './ModelEffortMenu'

export function ChatInput(): React.JSX.Element {
  const { t } = useTranslation()
  const { send, status } = useChatStore()
  const [text, setText] = useState('')
  const submit = (): void => {
    const v = text.trim()
    if (!v) return
    setText('')
    void send(v)
  }
  return (
    <div className="border-t border-black/5 p-3">
      <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          placeholder={t('chat.placeholder')}
          disabled={status === 'running'}
          className="flex-1 bg-transparent outline-none"
        />
        <button
          onClick={submit}
          disabled={status === 'running'}
          className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-[var(--text)] text-white disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* 권한 모드 옆에 모델 · 추론 강도 선택(Aside 하단 줄과 같은 자리) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PermissionMenu />
        <ModelEffortMenu />
      </div>
    </div>
  )
}
