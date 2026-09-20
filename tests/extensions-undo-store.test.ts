// 확장 제거 되돌리기(M4). 확인창 없이 바로 지우되 5초 동안 되돌릴 수 있어야 한다.
// window.samba 는 스텁으로 갈아 끼우고 타이머는 가짜 시계로 돌린다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useExtensionStore,
  EXTENSION_UNDO_MS
} from '../src/renderer/src/stores/extensionStore'

interface FakeItem {
  id: string
  name: string
  path: string
  enabled: boolean
}

let items: FakeItem[] = []

const remove = vi.fn(async (id: string) => {
  items = items.filter((e) => e.id !== id)
  return { ok: true as const, data: undefined }
})
const load = vi.fn(async (path?: string) => {
  if (path) items.push({ id: 'ext1', name: '메모 확장', path, enabled: true })
  return { ok: true as const, data: null }
})
const list = vi.fn(async () => ({ ok: true as const, data: { items, errors: [] } }))

beforeEach(() => {
  vi.useFakeTimers()
  items = [{ id: 'ext1', name: '메모 확장', path: 'C:/ext/memo', enabled: true }]
  remove.mockClear()
  load.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    samba: { extensions: { list, remove, load } }
  }
  useExtensionStore.setState({ items: [...items], removed: null, message: '' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('확장 제거 되돌리기', () => {
  it('제거하면 목록에서 빠지고 되돌리기 표식이 남는다', async () => {
    await useExtensionStore.getState().remove('ext1')
    expect(useExtensionStore.getState().items).toHaveLength(0)
    expect(useExtensionStore.getState().removed).toEqual({
      id: 'ext1',
      name: '메모 확장',
      path: 'C:/ext/memo'
    })
  })

  it('5초가 지나면 되돌리기 표식이 사라진다', async () => {
    await useExtensionStore.getState().remove('ext1')
    vi.advanceTimersByTime(EXTENSION_UNDO_MS - 1)
    expect(useExtensionStore.getState().removed).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(useExtensionStore.getState().removed).toBeNull()
  })

  it('되돌리면 같은 폴더를 다시 불러와 목록에 돌아온다', async () => {
    await useExtensionStore.getState().remove('ext1')
    await useExtensionStore.getState().undoRemove()
    expect(load).toHaveBeenCalledWith('C:/ext/memo')
    expect(useExtensionStore.getState().items).toHaveLength(1)
    expect(useExtensionStore.getState().removed).toBeNull()
  })

  it('되돌리기를 닫으면 타이머가 멈추고 표식만 사라진다', async () => {
    await useExtensionStore.getState().remove('ext1')
    useExtensionStore.getState().dismissRemoved()
    expect(useExtensionStore.getState().removed).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('제거에 실패하면 되돌리기 표식을 만들지 않는다', async () => {
    remove.mockResolvedValueOnce({ ok: false, error: '실패' } as never)
    await useExtensionStore.getState().remove('ext1')
    expect(useExtensionStore.getState().removed).toBeNull()
    expect(useExtensionStore.getState().message).toBe('실패')
  })
})
