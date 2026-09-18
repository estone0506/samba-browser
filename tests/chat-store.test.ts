import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/ipc'

// 렌더러 전역 window.samba 스텁 (스토어는 순수 zustand 라 node 에서 그대로 돌릴 수 있다)
const run = vi.fn(async () => ({ ok: true as const, data: undefined }))
const stop = vi.fn(async () => ({ ok: true as const, data: undefined }))
const win = { samba: { agent: { run, stop, confirmReply: vi.fn(), onEvent: vi.fn() } } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).window = win

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')

const fire = (e: AgentEvent): void => useChatStore.getState().handleEvent(e)

describe('chatStore 상태 가드', () => {
  beforeEach(() => {
    run.mockClear()
    useChatStore.setState({
      messages: [],
      status: 'idle',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      confirm: null,
      authError: null
    })
  })

  it('중단 뒤 뒤늦게 온 running 은 무시한다', () => {
    useChatStore.setState({ status: 'stopped' })
    fire({ type: 'status', state: 'running', toolCalls: 0 })
    expect(useChatStore.getState().status).toBe('stopped')
  })

  it('실패·완료 뒤의 running 도 무시한다', () => {
    useChatStore.setState({ status: 'failed' })
    fire({ type: 'status', state: 'running' })
    expect(useChatStore.getState().status).toBe('failed')
    useChatStore.setState({ status: 'done' })
    fire({ type: 'status', state: 'running' })
    expect(useChatStore.getState().status).toBe('done')
  })

  it('send() 로 시작한 실행의 running 은 반영된다', async () => {
    await useChatStore.getState().send('구글 검색')
    expect(run).toHaveBeenCalledWith('구글 검색')
    fire({ type: 'status', state: 'running', toolCalls: 0 })
    expect(useChatStore.getState().status).toBe('running')
  })

  it('중단 뒤 새 작업을 다시 보낼 수 있다', async () => {
    useChatStore.setState({ status: 'stopped' })
    await useChatStore.getState().send('다시')
    expect(useChatStore.getState().status).toBe('running')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stopped 상태는 그대로 반영된다', () => {
    useChatStore.setState({ status: 'running' })
    fire({ type: 'status', state: 'stopped' })
    expect(useChatStore.getState().status).toBe('stopped')
  })

  it('api_retry 진행 이벤트는 retry 로 보관하고 step 이 오면 지운다', () => {
    useChatStore.setState({
      status: 'running',
      messages: [{ id: '1', role: 'ai', text: '', steps: [] }]
    })
    fire({ type: 'progress', kind: 'apiRetry', attempt: 3, reason: 'rate_limit' })
    expect(useChatStore.getState().retry).toEqual({ attempt: 3, reason: 'rate_limit' })
    fire({ type: 'step', label: '클릭', ok: true })
    expect(useChatStore.getState().retry).toBeNull()
  })
})
