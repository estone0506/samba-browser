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
  // 번역 키. 있으면 화면에서 i18n 문구로 바꿔 보여 준다(메인이 보내는 label 은 그대로 표시)
  key?: string
}

// 캡차·2FA 사용자 넘김 카드 상태
export interface Handoff {
  requestId: string
  matched: string
  url: string
}

// SDK 재시도 대기 표시용 (진행 띠 라벨은 i18n 으로 화면에서 조립)
export interface Retry {
  attempt: number
  reason: string
}

interface ChatState {
  messages: ChatMessage[]
  // 실행 세대 번호. 이전 작업의 늦은 IPC 응답이 새 작업 UI 를 덮지 않게 한다
  runSeq: number
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  toolCalls: number
  currentLabel: string
  retry: Retry | null
  confirm: { requestId: string; action: string; kind: 'danger' | 'finish' } | null
  // 사이트가 사람의 추가 확인을 요구해 작업이 멈춰 있는 상태
  handoff: Handoff | null
  authError: 'missing' | 'limit' | null
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  reply: (requestId: string, approved: boolean) => void
  // 넘김 카드 응답 — skip=true 는 건너뛰고 계속, false 는 작업 중단
  replyHandoff: (requestId: string, skip: boolean) => void
  handleEvent: (e: AgentEvent) => void
}

let seq = 0
const nid = (): string => String(++seq)

// 진행 로그(step)는 마지막 AI 메시지에 붙인다
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  runSeq: 0,
  status: 'idle',
  toolCalls: 0,
  currentLabel: '',
  retry: null,
  confirm: null,
  handoff: null,
  authError: null,
  send: async (text) => {
    if (get().status === 'running') return
    const seq = get().runSeq + 1
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nid(), role: 'user', text },
        { id: nid(), role: 'ai', text: '', steps: [] }
      ],
      runSeq: seq,
      status: 'running',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      confirm: null,
      handoff: null,
      authError: null
    }))
    // 메인은 "시작 접수" ack 만 즉시 돌려준다. 완료·실패는 status 이벤트로 온다.
    // 늦게 도착한 이전 세대의 응답은 버린다
    const r = await window.samba.agent.run(text)
    if (!r.ok && get().runSeq === seq) set({ status: 'failed', currentLabel: r.error, retry: null })
  },
  stop: async () => {
    await window.samba.agent.stop()
  },
  reply: (requestId, approved) => {
    window.samba.agent.confirmReply(requestId, approved)
    set({ confirm: null })
  },
  // 넘김 카드도 확인 카드와 같은 응답 채널을 쓴다(승인=건너뛰고 계속, 거부=작업 중단)
  replyHandoff: (requestId, skip) => {
    window.samba.agent.confirmReply(requestId, skip)
    set({ handoff: null })
    // '작업 중단'은 응답만으로 끝나지 않는다 — 실행 자체를 멈춘다
    if (!skip) void window.samba.agent.stop()
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
      set((s) => ({ toolCalls: s.toolCalls + 1, currentLabel: e.label, retry: null }))
    }
    if (e.type === 'progress') set({ retry: { attempt: e.attempt, reason: e.reason } })
    if (e.type === 'confirm')
      set({ confirm: { requestId: e.requestId, action: e.action, kind: e.kind ?? 'danger' } })
    if (e.type === 'handoff') {
      set({ handoff: { requestId: e.requestId, matched: e.matched, url: e.url } })
      if (last?.role === 'ai') {
        patchLast({
          steps: [...(last.steps ?? []), { label: '', ok: true, key: 'handoff.waiting' }]
        })
      }
    }
    if (e.type === 'handoffDone') {
      // 자동 재개·시간 초과로 끝났을 수도 있으므로 카드를 항상 닫는다
      set({ handoff: null })
      if (last?.role === 'ai') {
        patchLast({
          steps: [
            ...(last.steps ?? []),
            {
              label: '',
              ok: e.outcome !== 'aborted' && e.outcome !== 'timeout',
              key: `handoff.step.${e.outcome}`
            }
          ]
        })
      }
    }
    if (e.type === 'status') {
      // 중단·실패·완료 뒤에 뒤늦게 도착한 running 은 무시한다.
      // send() 가 실행을 시작할 때 status 를 먼저 running 으로 바꾸므로 정상 시작은 통과한다
      if (e.state === 'running' && get().status !== 'running') return
      const auth = e.message?.startsWith('auth:')
        ? (e.message.slice(5) as 'missing' | 'limit')
        : null
      const done = e.state === 'done' || e.state === 'failed' || e.state === 'stopped'
      set({
        status: e.state,
        authError: auth,
        toolCalls: e.toolCalls ?? get().toolCalls,
        retry: e.state === 'running' ? get().retry : null,
        // 중단 후 응답 불가능한 확인·넘김 카드가 남지 않도록 정리
        confirm: done ? null : get().confirm,
        handoff: done ? null : get().handoff
      })
    }
  }
}))
