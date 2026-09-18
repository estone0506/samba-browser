import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentEvent, AgentRunAck, IpcResult } from '../src/shared/ipc'

// 렌더러 전역 window.samba 스텁 (스토어는 순수 zustand 라 node 에서 그대로 돌릴 수 있다).
// agent:run 은 "시작 접수" ack 만 즉시 돌려준다
const ack: IpcResult<AgentRunAck> = { ok: true, data: { started: true } }
const run = vi.fn(async (_prompt: string): Promise<IpcResult<AgentRunAck>> => ack)
const stop = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
const win = { samba: { agent: { run, stop, confirmReply: vi.fn(), onEvent: vi.fn() } } }
Object.assign(globalThis, { window: win })

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')

const fire = (e: AgentEvent): void => useChatStore.getState().handleEvent(e)

describe('chatStore 상태 가드', () => {
  beforeEach(() => {
    run.mockReset()
    run.mockImplementation(async () => ack)
    useChatStore.setState({
      messages: [],
      runSeq: 0,
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

  it('confirm 대기 중 stopped 가 오면 confirm 을 정리한다', () => {
    useChatStore.setState({
      status: 'running',
      confirm: { requestId: 'req-1', action: '위험한 작업', kind: 'danger' }
    })
    fire({ type: 'status', state: 'stopped' })
    expect(useChatStore.getState().status).toBe('stopped')
    expect(useChatStore.getState().confirm).toBeNull()
  })

  it('이전 run 의 늦은 오류 응답이 새 실행을 failed 로 덮지 않는다', async () => {
    // 첫 실행의 invoke 는 아주 늦게 ok:false 로 끝난다
    let releaseFirst: (r: IpcResult<AgentRunAck>) => void = () => {}
    run.mockImplementationOnce(
      () => new Promise<IpcResult<AgentRunAck>>((resolve) => (releaseFirst = resolve))
    )
    const first = useChatStore.getState().send('첫 작업')
    expect(useChatStore.getState().status).toBe('running')

    // 사용자가 중단하고 새 작업을 시작
    useChatStore.getState().handleEvent({ type: 'status', state: 'stopped' })
    await useChatStore.getState().send('두 번째 작업')
    expect(useChatStore.getState().status).toBe('running')

    // 이제서야 첫 실행의 실패 응답이 도착해도 새 실행 상태는 그대로여야 한다
    releaseFirst({ ok: false, error: '이미 실행 중' })
    await first
    expect(useChatStore.getState().status).toBe('running')
    expect(useChatStore.getState().currentLabel).toBe('')
  })

  it('현재 실행의 ok:false 응답은 failed 로 반영된다', async () => {
    run.mockImplementationOnce(async () => ({ ok: false as const, error: '시작 실패' }))
    await useChatStore.getState().send('작업')
    expect(useChatStore.getState().status).toBe('failed')
    expect(useChatStore.getState().currentLabel).toBe('시작 실패')
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
