// 설정 주소를 그때그때 읽어 부른다 — 주소를 고치면 다음 호출부터 바로 반영된다
import { describe, it, expect, vi } from 'vitest'
import { createHarnessApi } from '../src/main/harness/wiring'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

function fetchOk(): typeof globalThis.fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })
  ) as unknown as typeof globalThis.fetch
}

describe('createHarnessApi', () => {
  it('설정의 주소로 읽는다', async () => {
    const fetchImpl = fetchOk()
    const api = createHarnessApi(() => ({ ...DEFAULT_SETTINGS }) as Settings, fetchImpl)
    const r = await api.jobs()
    expect(r.status).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:47812/jobs', expect.anything())
  })

  it('주소를 고치면 다음 호출부터 새 주소로 간다', async () => {
    const fetchImpl = fetchOk()
    let url = 'http://127.0.0.1:47812'
    const api = createHarnessApi(
      () => ({ ...DEFAULT_SETTINGS, harnessApiUrl: url }) as Settings,
      fetchImpl
    )
    await api.jobs()
    url = 'http://127.0.0.1:48000'
    await api.jobs()
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:48000/jobs', expect.anything())
  })

  it('규칙 저장은 빈 글을 보내지 않는다(하네스가 400 을 주기 전에 막는다)', async () => {
    const fetchImpl = fetchOk()
    const api = createHarnessApi(() => ({ ...DEFAULT_SETTINGS }) as Settings, fetchImpl)
    const r = await api.putRules('buyer.musinsa', '   ')
    expect(r.status).toBe('bad-response')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
