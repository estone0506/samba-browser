// 하네스 읽기 API 클라이언트 — 성공 / 127.0.0.1 밖 거부 / 연결 거부 / 타임아웃 / JSON 아님 / 401·404 / 큰 본문
import { describe, it, expect, vi } from 'vitest'
import { HarnessClient, localHarnessBase } from '../src/main/harness/client'

const URL_OK = 'http://127.0.0.1:47812'

function jsonFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
  ) as unknown as typeof globalThis.fetch
}

describe('localHarnessBase', () => {
  it('127.0.0.1·localhost 의 http 주소만 받는다', () => {
    expect(localHarnessBase('http://127.0.0.1:47812')).toBe('http://127.0.0.1:47812')
    expect(localHarnessBase('http://localhost:47812/')).toBe('http://localhost:47812')
    expect(localHarnessBase('http://10.0.0.5:47812')).toBeNull()
    expect(localHarnessBase('https://example.com')).toBeNull()
    expect(localHarnessBase('그냥 글자')).toBeNull()
  })
})

describe('HarnessClient', () => {
  it('graph 를 읽는다', async () => {
    const fetchImpl = jsonFetch({ version: 'v1', stages: ['buy'], agents: [] })
    const c = new HarnessClient({ url: () => URL_OK, fetchImpl })
    const r = await c.graph()
    expect(r.status).toBe('ok')
    expect(r.data?.version).toBe('v1')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${URL_OK}/graph`,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('127.0.0.1 밖 주소는 부르지 않는다', async () => {
    const fetchImpl = jsonFetch({})
    const r = await new HarnessClient({ url: () => 'http://10.0.0.5:47812', fetchImpl }).jobs()
    expect(r.status).toBe('bad-url')
    expect(r.data).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('하네스가 꺼져 있으면 offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).jobs()
    expect(r.status).toBe('offline')
  })

  it('응답이 없으면 제한 시간에 끊고 timeout', async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl, timeoutMs: 20 }).releases()
    expect(r.status).toBe('timeout')
  })

  it('JSON 이 아니면 bad-response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>nope</html>', { status: 200 })
    ) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).graph()
    expect(r.status).toBe('bad-response')
    expect(r.error).not.toBe('')
  })

  it('401·404 는 사유를 담아 bad-response', async () => {
    const r401 = await new HarnessClient({
      url: () => URL_OK,
      fetchImpl: jsonFetch({ error: 'unauthorized' }, 401)
    }).jobs()
    expect(r401.status).toBe('bad-response')
    expect(r401.error).toContain('401')
    const r404 = await new HarnessClient({
      url: () => URL_OK,
      fetchImpl: jsonFetch({ error: 'unknown agent: x' }, 404)
    }).putRules('x', '규칙')
    expect(r404.status).toBe('bad-response')
    expect(r404.error).toContain('404')
  })

  it('규칙 저장은 PUT 과 본문 {text} 로 보낸다', async () => {
    const fetchImpl = jsonFetch({ ok: true, version: 'v2' })
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).putRules(
      'buyer.musinsa',
      '새 규칙'
    )
    expect(r.status).toBe('ok')
    expect(r.data?.version).toBe('v2')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${URL_OK}/graph/rules/buyer.musinsa`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ text: '새 규칙' }) })
    )
  })

  it('규칙 파일을 읽는다(getRules, GET)', async () => {
    const fetchImpl = jsonFetch({ agent: 'buyer.musinsa', text: '규칙 본문', version: 'v3' })
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).getRules('buyer.musinsa')
    expect(r.status).toBe('ok')
    expect(r.data?.text).toBe('규칙 본문')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${URL_OK}/graph/rules/buyer.musinsa`,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('큰 본문은 오류 메시지를 잘라서 담는다(413 payload too large)', async () => {
    const bigError = 'x'.repeat(5000)
    const fetchImpl = jsonFetch({ error: bigError }, 413)
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).putRules(
      'buyer.musinsa',
      'y'.repeat(5000)
    )
    expect(r.status).toBe('bad-response')
    expect(r.error.length).toBeLessThan(300)
    expect(r.error).toContain('413')
  })
})
