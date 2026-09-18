import type React from 'react'
import { useEffect, useRef } from 'react'
import { useChatStore } from '@renderer/stores/chatStore'
import { StepLog } from './StepLog'

export function MessageList(): React.JSX.Element {
  const { messages, status } = useChatStore()
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3.5">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div
            key={m.id}
            className="max-w-[88%] self-end rounded-2xl rounded-br-[4px] bg-[var(--text)] px-3 py-2 leading-relaxed text-white"
          >
            {m.text}
          </div>
        ) : (
          <div key={m.id} className="max-w-[94%] self-start leading-relaxed">
            <div className="whitespace-pre-wrap">{m.text}</div>
            <StepLog
              steps={m.steps ?? []}
              running={status === 'running' && i === messages.length - 1}
            />
          </div>
        )
      )}
      <div ref={end} />
    </div>
  )
}
