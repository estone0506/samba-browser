// 하네스 스토어 — 진입 시 한 번, 그 뒤 5초마다, 꺼져 있으면 상태만 바뀐다
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HARNESS_POLL_MS, useHarnessStore } from '@renderer/stores/harnessStore'

interface FakeApi {
  graph: ReturnType<typeof vi.fn>
  jobs: ReturnType<typeof vi.fn>
  releases: ReturnType<typeof vi.fn>
  getRules: ReturnType<typeof vi.fn>
  putRules: ReturnType<typeof vi.fn>
}

function ok<T>(data: T): { ok: true; data: { status: 'ok'; data: T; error: '' } } {
  return { ok: true, data: { status: 'ok', data, error: '' } }
}

let api: FakeApi

beforeEach(() => {
  vi.useFakeTimers()
  api = {
    graph: vi.fn(async () => ok({ version: 'v1', stages: ['buy'], agents: [] })),
    jobs: vi.fn(async () => ok({ jobs: [{ order_no: '1', state: 'running' }] })),
    releases: vi.fn(async () => ok({ current: null, history: [], candidate: null })),
    getRules: vi.fn(async () => ok({ agent: 'buyer.musinsa', text: '규칙', version: 'v1' })),
    putRules: vi.fn(async () => ok({ ok: true, version: 'v2' }))
  }
  ;(globalThis as unknown as { window: { samba: { harness: FakeApi } } }).window = {
    samba: { harness: api }
  }
  useHarnessStore.setState({ graph: null, jobs: [], releases: null, status: 'offline', error: '' })
})

afterEach(() => vi.useRealTimers())

describe('harnessStore', () => {
  it('refresh 는 세 API 를 모두 읽는다', async () => {
    await useHarnessStore.getState().refresh()
    expect(api.graph).toHaveBeenCalledTimes(1)
    expect(useHarnessStore.getState().status).toBe('ok')
    expect(useHarnessStore.getState().jobs).toHaveLength(1)
  })

  it('폴링은 5초마다 jobs·releases 만 다시 읽고, 멈추면 더 읽지 않는다', async () => {
    const stop = useHarnessStore.getState().start()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.graph).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS)
    expect(api.jobs).toHaveBeenCalledTimes(2)
    expect(api.graph).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS * 2)
    expect(api.jobs).toHaveBeenCalledTimes(2)
  })

  it('하네스가 꺼지면 상태만 바뀌고 앞서 읽은 그래프는 남는다', async () => {
    await useHarnessStore.getState().refresh()
    api.jobs.mockResolvedValue({
      ok: true,
      data: { status: 'offline', data: null, error: 'fetch failed' }
    })
    api.releases.mockResolvedValue({
      ok: true,
      data: { status: 'offline', data: null, error: 'fetch failed' }
    })
    api.graph.mockResolvedValue({
      ok: true,
      data: { status: 'offline', data: null, error: 'fetch failed' }
    })
    await useHarnessStore.getState().refresh()
    expect(useHarnessStore.getState().status).toBe('offline')
    expect(useHarnessStore.getState().graph?.version).toBe('v1')
  })

  it('규칙 저장은 성공하면 그래프를 다시 읽고, 실패하면 사유를 남긴다', async () => {
    expect(await useHarnessStore.getState().putRules('buyer.musinsa', '새 규칙')).toBe(true)
    expect(api.putRules).toHaveBeenCalledWith('buyer.musinsa', '새 규칙')
    expect(api.graph).toHaveBeenCalled()
    api.putRules.mockResolvedValue({
      ok: true,
      data: { status: 'bad-response', data: null, error: 'HTTP 404: unknown agent' }
    })
    expect(await useHarnessStore.getState().putRules('없음', '새 규칙')).toBe(false)
    expect(useHarnessStore.getState().saveError).toContain('404')
    expect(useHarnessStore.getState().saving).toBe(false)
  })

  it('저장 중에는 다시 저장을 걸어도 API 를 또 부르지 않는다', async () => {
    let resolvePut: (v: unknown) => void = () => {}
    api.putRules.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve
      })
    )
    const first = useHarnessStore.getState().putRules('buyer.musinsa', '규칙 A')
    expect(useHarnessStore.getState().saving).toBe(true)
    const second = await useHarnessStore.getState().putRules('buyer.musinsa', '규칙 B')
    expect(second).toBe(false)
    expect(api.putRules).toHaveBeenCalledTimes(1)
    resolvePut(ok({ ok: true, version: 'v2' }))
    expect(await first).toBe(true)
  })

  it('getRules 는 규칙 원문을 그대로 돌려준다(편집 모달용, 브리프 외 추가)', async () => {
    const r = await useHarnessStore.getState().getRules('buyer.musinsa')
    expect(api.getRules).toHaveBeenCalledWith('buyer.musinsa')
    expect(r?.text).toBe('규칙')
  })

  it('이전 폴링이 5초 안에 안 끝나면 다음 틱은 겹쳐 쏘지 않는다(리뷰 지적 — Minor 6)', async () => {
    const stop = useHarnessStore.getState().start()
    // 진입 시 refresh 한 번은 기본 mock 으로 바로 끝난다
    await vi.advanceTimersByTimeAsync(0)
    expect(api.jobs).toHaveBeenCalledTimes(1)

    let resolveJobs: (v: unknown) => void = () => {}
    api.jobs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveJobs = resolve
      })
    )
    // 첫 폴링 틱 — jobs 가 응답하지 않는다
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS)
    expect(api.jobs).toHaveBeenCalledTimes(2)
    // 아직 첫 폴링이 안 끝났으니 다음 틱은 건너뛴다(겹쳐 쏘지 않는다)
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS)
    expect(api.jobs).toHaveBeenCalledTimes(2)

    resolveJobs(ok({ jobs: [] }))
    await vi.advanceTimersByTimeAsync(0)
    // 밀린 폴링이 풀렸으니 다음 틱부터는 다시 부른다
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS)
    expect(api.jobs).toHaveBeenCalledTimes(3)
    stop()
  })

  it('IPC 가 던져도 refresh 가 죽지 않고 offline 으로 남는다', async () => {
    api.graph.mockRejectedValueOnce(new Error('ipc broken'))
    await useHarnessStore.getState().refresh()
    expect(useHarnessStore.getState().status).toBe('offline')
  })
})
