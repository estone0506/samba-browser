import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentEvent, AgentRunAck, IpcResult } from '../src/shared/ipc'

// 렌더러 전역 window.samba 스텁 — 플레이북 배지·진행 배지 상태만 확인한다
const ack: IpcResult<AgentRunAck> = { ok: true, data: { started: true } }
const run = vi.fn(async (_prompt: string): Promise<IpcResult<AgentRunAck>> => ack)
const win = {
  samba: {
    agent: { run, stop: vi.fn(), confirmReply: vi.fn(), onEvent: vi.fn() },
    chats: { create: vi.fn(async () => ({ ok: false, error: 'no db' })) }
  }
}
Object.assign(globalThis, { window: win })

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')

const fire = (e: AgentEvent): void => useChatStore.getState().handleEvent(e)

describe('chatStore — 플레이북 배지와 진행 배지', () => {
  beforeEach(() => {
    run.mockClear()
    useChatStore.setState({
      messages: [],
      runSeq: 0,
      status: 'idle',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      playbookNames: [],
      taskProgress: null,
      confirm: null,
      handoff: null,
      authError: null
    })
  })

  it('playbook 이벤트로 적용된 이름을 받는다', () => {
    fire({ type: 'playbook', names: ['삼바 미이행 주문 처리'] })
    expect(useChatStore.getState().playbookNames).toEqual(['삼바 미이행 주문 처리'])
  })

  it('task 진행 이벤트는 진행 배지에, apiRetry 는 재시도 표시에 들어간다', () => {
    fire({ type: 'progress', kind: 'task', done: 3, total: 26, label: '티셔츠' })
    expect(useChatStore.getState().taskProgress).toEqual({ done: 3, total: 26, label: '티셔츠' })
    expect(useChatStore.getState().retry).toBeNull()

    fire({ type: 'progress', kind: 'apiRetry', attempt: 2, reason: 'overloaded' })
    expect(useChatStore.getState().retry).toEqual({ attempt: 2, reason: 'overloaded' })
    // 재시도 이벤트가 진행 배지를 지우지 않는다
    expect(useChatStore.getState().taskProgress).toEqual({ done: 3, total: 26, label: '티셔츠' })
  })

  it('라벨 없는 진행 이벤트도 받는다', () => {
    fire({ type: 'progress', kind: 'task', done: 0, total: 5 })
    expect(useChatStore.getState().taskProgress).toEqual({ done: 0, total: 5 })
  })

  it('새 작업을 보내면 이전 실행의 배지가 지워진다', async () => {
    useChatStore.setState({ playbookNames: ['옛 플레이북'], taskProgress: { done: 1, total: 2 } })
    await useChatStore.getState().send('삼바 미이행 주문건 처리해줘')
    expect(useChatStore.getState().playbookNames).toEqual([])
    expect(useChatStore.getState().taskProgress).toBeNull()
  })
})
