import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FaviconService,
  FAVICON_MAX_BYTES,
  FAVICON_MEMORY_CACHE_LIMIT,
  FAVICON_NEGATIVE_TTL_MS,
  FAVICON_TTL_MS,
  safeFaviconHost,
  type FaviconFetch,
  type FaviconResponse
} from '../src/main/favicon/service'

// net.fetch 흉내. 실제 네트워크는 절대 타지 않는다
function response(
  body: Uint8Array | string,
  contentType = 'image/png',
  ok = true,
  extra: Record<string, string> = {}
): FaviconResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const headers: Record<string, string> = { 'content-type': contentType, ...extra }
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'samba-favicon-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('safeFaviconHost — 호스트 검증', () => {
  it('정상 호스트는 정규화해서 돌려준다', () => {
    expect(safeFaviconHost('https://www.Naver.com/login')).toBe('naver.com')
    expect(safeFaviconHost('shop.example.co.kr')).toBe('shop.example.co.kr')
  })

  it('경로 이탈·비정상 값은 빈 문자열이다', () => {
    for (const bad of ['', '   ', '..', '../../etc/passwd', 'a/b', 'a\\b', 'exam ple.com', 'com']) {
      expect(safeFaviconHost(bad)).toBe('')
    }
  })
})

describe('FaviconService — 캐시와 네트워크', () => {
  it('유효하지 않은 호스트는 요청조차 하지 않는다', async () => {
    const fetchFn = vi.fn<FaviconFetch>()
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(await s.get('../../etc')).toBeNull()
    expect(await s.get('')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('사이트 자체에만 요청하고 dataUrl 을 돌려준다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    const dataUrl = await s.get('https://www.example.com/login')
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe('https://example.com/favicon.ico')
    // 제3자(구글 등)로 나가는 요청이 하나도 없어야 한다
    for (const [url] of fetchFn.mock.calls) expect(url).toContain('example.com')
  })

  it('첫 요청이 실패하면 www 를 한 번 더 시도한다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async (url) =>
      url.startsWith('https://www.') ? response(PNG) : response('', 'text/html', false)
    )
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(await s.get('example.com')).toContain('data:image/png;base64,')
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/favicon.ico',
      'https://www.example.com/favicon.ico'
    ])
  })

  it('두 번째 조회는 캐시에서 바로 나온다(요청 없음)', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    await s.get('example.com')
    await s.get('example.com')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(s.peek('example.com')).toContain('data:image/png;base64,')
  })

  it('디스크 캐시는 새 인스턴스에서도 쓰인다', async () => {
    const first = vi.fn<FaviconFetch>(async () => response(PNG))
    await new FaviconService({ cacheDir: dir, fetch: first }).get('example.com')
    expect(await readdir(dir)).toEqual(['example.com.png'])
    const second = vi.fn<FaviconFetch>(async () => response(PNG))
    const dataUrl = await new FaviconService({ cacheDir: dir, fetch: second }).get('example.com')
    expect(dataUrl).toContain('data:image/png;base64,')
    expect(second).not.toHaveBeenCalled()
  })

  it('캐시가 7일을 넘기면 다시 받아온다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    let now = Date.now()
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn, now: () => now })
    await s.get('example.com')
    now += FAVICON_TTL_MS * 2
    await s.get('example.com')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('실패는 1일 동안 null 로 캐시한다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response('', 'text/html', false))
    let now = Date.now()
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn, now: () => now })
    expect(await s.get('example.com')).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2) // 원본 + www
    expect(await s.get('example.com')).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2) // 캐시된 실패라 재요청 없음
    expect(await readdir(dir)).toEqual(['example.com.none'])
    now += FAVICON_NEGATIVE_TTL_MS * 2
    await s.get('example.com')
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })

  it('64KB 를 넘으면 버린다(본문·content-length 양쪽)', async () => {
    const big = new Uint8Array(FAVICON_MAX_BYTES + 1)
    const byBody = vi.fn<FaviconFetch>(async () => response(big))
    expect(await new FaviconService({ cacheDir: dir, fetch: byBody }).get('example.com')).toBeNull()

    const byHeader = vi.fn<FaviconFetch>(async () =>
      response(PNG, 'image/png', true, { 'content-length': String(FAVICON_MAX_BYTES + 1) })
    )
    const s = new FaviconService({ cacheDir: join(dir, 'b'), fetch: byHeader })
    expect(await s.get('example.com')).toBeNull()
  })

  it('image/* 가 아니면 버린다(HTML 오류 페이지 방어)', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response('<html>not found</html>', 'text/html'))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(await s.get('example.com')).toBeNull()
  })

  it('허용 목록에 없는 이미지 MIME(svg 등)은 버린다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response('<svg></svg>', 'image/svg+xml'))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(await s.get('example.com')).toBeNull()
  })

  it('허용 목록의 MIME(png/x-icon/vnd.microsoft.icon/jpeg/gif/webp)은 통과한다', async () => {
    for (const mime of [
      'image/png',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/jpeg',
      'image/gif',
      'image/webp'
    ]) {
      const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG, mime))
      const s = new FaviconService({
        cacheDir: join(dir, mime.replace(/\W/g, '_')),
        fetch: fetchFn
      })
      expect(await s.get('example.com')).toContain(`data:${mime};base64,`)
    }
  })

  it('빈 본문은 파비콘으로 보지 않는다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(new Uint8Array(0)))
    expect(
      await new FaviconService({ cacheDir: dir, fetch: fetchFn }).get('example.com')
    ).toBeNull()
  })

  it('요청이 터져도 예외를 밖으로 던지지 않는다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => {
      throw new Error('ETIMEDOUT')
    })
    expect(
      await new FaviconService({ cacheDir: dir, fetch: fetchFn }).get('example.com')
    ).toBeNull()
  })

  it('동시 요청은 한 번만 나간다', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetchFn = vi.fn<FaviconFetch>(async () => {
      await gate
      return response(PNG)
    })
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    const all = Promise.all([s.get('example.com'), s.get('EXAMPLE.com'), s.get('www.example.com')])
    release?.()
    const results = await all
    expect(new Set(results).size).toBe(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('메모리 캐시는 상한을 넘으면 가장 오래된 항목부터 버린다(LRU)', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    // 상한을 3으로 줄여 넣는다 — 기본 상한(200)만큼 파일을 쓰면 느린 디스크에서
    // 테스트가 시간 초과로 간헐 실패했다. 판정 논리는 상한 값과 무관하다
    const limit = 3
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn, memoryLimit: limit })
    for (let i = 0; i < limit + 1; i++) {
      await s.get(`host${i}.example.com`)
    }
    // 가장 먼저 넣은 host0 은 밀려나 peek 이 null(메모리에는 없음)
    expect(s.peek('host0.example.com')).toBeNull()
    // 가장 최근 것은 남아 있다
    expect(s.peek(`host${limit}.example.com`)).toContain('data:image/png')
    // 기본 상한은 그대로 200 이다
    expect(FAVICON_MEMORY_CACHE_LIMIT).toBe(200)
  })

  it('peek 은 캐시에 없으면 null 이고 네트워크를 타지 않는다', () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(s.peek('example.com')).toBeNull()
    expect(s.peek('../../etc')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('망가진 캐시 파일은 무시하고 다시 받아온다', async () => {
    await writeFile(join(dir, 'example.com.png'), 'garbage', 'utf-8')
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    expect(await s.get('example.com')).toContain('data:image/png;base64,')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('FaviconService.storeFromPage — 탭이 받은 파비콘 저장', () => {
  it('페이지가 알려준 파비콘 URL 을 같은 캐시에 넣는다', async () => {
    const base = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: base })
    const tabFetch = vi.fn<FaviconFetch>(async () => response(PNG, 'image/x-icon'))
    await s.storeFromPage(
      'https://www.example.com/login',
      'https://cdn.example.com/i.ico',
      tabFetch
    )
    expect(tabFetch).toHaveBeenCalledTimes(1)
    expect(s.peek('example.com')).toContain('data:image/x-icon;base64,')
    // 캐시에 들어갔으므로 get() 이 네트워크를 다시 타지 않는다
    expect(await s.get('example.com')).toContain('data:image/x-icon;base64,')
    expect(base).not.toHaveBeenCalled()
  })

  it('http(s) 가 아닌 아이콘 주소와 잘못된 페이지 호스트는 무시한다', async () => {
    const tabFetch = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: tabFetch })
    await s.storeFromPage('https://example.com', 'data:image/png;base64,AAAA', tabFetch)
    await s.storeFromPage('samba://newtab', 'https://example.com/i.ico', tabFetch)
    expect(tabFetch).not.toHaveBeenCalled()
  })

  it('사설·루프백 주소의 아이콘 URL 은 요청하지 않는다(SSRF 방지)', async () => {
    const tabFetch = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: tabFetch })
    const privateUrls = [
      'http://127.0.0.1/i.ico',
      'http://localhost/i.ico',
      'http://10.0.0.5/i.ico',
      'http://192.168.1.1/i.ico',
      'http://172.16.0.1/i.ico',
      'http://172.31.255.255/i.ico',
      'http://[::1]/i.ico'
    ]
    for (const url of privateUrls) {
      await s.storeFromPage('https://example.com', url, tabFetch)
    }
    expect(tabFetch).not.toHaveBeenCalled()
  })

  it('공인 주소의 아이콘 URL 은 정상 요청한다', async () => {
    const tabFetch = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: tabFetch })
    await s.storeFromPage('https://example.com', 'https://172.32.0.1/i.ico', tabFetch)
    expect(tabFetch).toHaveBeenCalledTimes(1)
  })

  it('이미 신선한 아이콘이 있으면 다시 받지 않는다', async () => {
    const fetchFn = vi.fn<FaviconFetch>(async () => response(PNG))
    const s = new FaviconService({ cacheDir: dir, fetch: fetchFn })
    await s.get('example.com')
    await s.storeFromPage('https://example.com', 'https://example.com/i.ico', fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
