import { create } from 'zustand'
import type { AgentEvent } from '@shared/ipc'

export interface ChatMessage {
  id: string
  role: 'user' | 'ai'
  text: string
  steps?: Step[]
}
export interface Step {
  label: string
  ok: boolean
}

interface ChatState {
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  toolCalls: number
  currentLabel: string
  confirm: { requestId: string; action: string } | null
  authError: 'missing' | 'limit' | null
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  reply: (requestId: string, approved: boolean) => void
  handleEvent: (e: AgentEvent) => void
}

let seq = 0
const nid = (): string => String(++seq)

// 진행 로그(step)는 마지막 AI 메시지에 붙인다
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: 'idle',
  toolCalls: 0,
  currentLabel: '',
  confirm: null,
  authError: null,
  send: async (text) => {
    if (get().status === 'running') return
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nid(), role: 'user', text },
        { id: nid(), role: 'ai', text: '', steps: [] }
      ],
      status: 'running',
      toolCalls: 0,
      authError: null
    }))
    const r = await window.samba.agent.run(text)
    if (!r.ok) set({ status: 'failed', currentLabel: r.error })
  },
  stop: async () => {
    await window.samba.agent.stop()
  },
  reply: (requestId, approved) => {
    window.samba.agent.confirmReply(requestId, approved)
    set({ confirm: null })
  },
  handleEvent: (e) => {
    const msgs = get().messages
    const last = msgs[msgs.length - 1]
    const patchLast = (p: Partial<ChatMessage>): void =>
      set({ messages: [...msgs.slice(0, -1), { ...last, ...p }] })
    if (e.type === 'text' && last?.role === 'ai')
      patchLast({ text: last.text ? `${last.text}\n${e.text}` : e.text })
    if (e.type === 'step' && last?.role === 'ai') {
      patchLast({ steps: [...(last.steps ?? []), { label: e.label, ok: e.ok }] })
      set((s) => ({ toolCalls: s.toolCalls + 1, currentLabel: e.label }))
    }
    if (e.type === 'confirm') set({ confirm: { requestId: e.requestId, action: e.action } })
    if (e.type === 'status') {
      const auth = e.message?.startsWith('auth:')
        ? (e.message.slice(5) as 'missing' | 'limit')
        : null
      set({ status: e.state, authError: auth, toolCalls: e.toolCalls ?? get().toolCalls })
    }
  }
}))
