import { describe, it, expect } from 'vitest'
import {
  CLAUDE_CREDENTIAL_PATHS,
  SERVICE_CREDIT_DETAIL_KEY,
  VERSION_TIMEOUT_MS,
  detectClaudeSubscription,
  detectProviders,
  testApiKey,
  type ProviderProbes
} from '../src/main/ai/providers'

// 감지에 필요한 두 가지(파일 존재 · claude --version 실행)만 주입한다
function makeProbes(o: {
  loggedIn?: boolean
  installed?: boolean | 'hang'
  onVersion?: () => void
}): ProviderProbes {
  return {
    fileExists: (p: string) => Boolean(o.loggedIn) && CLAUDE_CREDENTIAL_PATHS.includes(p),
    runVersion: () => {
      o.onVersion?.()
      if (o.installed === 'hang') return new Promise<boolean>(() => {})
      return Promise.resolve(o.installed !== false)
    }
  }
}

describe('detectClaudeSubscription', () => {
  it('자격 파일 있음 + 실행 성공 → connected', async () => {
    const s = await detectClaudeSubscription(makeProbes({ loggedIn: true, installed: true }))
    expect(s).toEqual({ id: 'claude_subscription', state: 'connected', maskedKeys: {} })
  })

  it('자격 파일 없음 + 실행 성공 → needs_login', async () => {
    const s = await detectClaudeSubscription(makeProbes({ loggedIn: false, installed: true }))
    expect(s.state).toBe('needs_login')
  })

  it('실행 실패(ENOENT) → not_installed', async () => {
    const s = await detectClaudeSubscription(makeProbes({ loggedIn: true, installed: false }))
    expect(s.state).toBe('not_installed')
  })

  it('실행이 상한 시간을 넘기면 타임아웃으로 not_installed', async () => {
    const s = await detectClaudeSubscription(makeProbes({ loggedIn: true, installed: 'hang' }), 10)
    expect(s.state).toBe('not_installed')
  })

  it('버전 확인 상한은 3초다', () => {
    expect(VERSION_TIMEOUT_MS).toBe(3000)
  })

  it('반환값에 키·토큰 문자열이 전혀 없다', async () => {
    const s = await detectClaudeSubscription(makeProbes({ loggedIn: true, installed: true }))
    const json = JSON.stringify(s).toLowerCase()
    expect(s.maskedKeys).toEqual({})
    expect(json).not.toContain('sk-')
    expect(json).not.toContain('token')
    expect(json).not.toContain('credential')
  })
})

describe('detectProviders', () => {
  it('세 장의 카드를 항상 같은 순서로 돌려준다', async () => {
    const list = await detectProviders(makeProbes({ loggedIn: true, installed: true }), {})
    expect(list.map((p) => p.id)).toEqual(['claude_subscription', 'api_key', 'service_credit'])
  })

  it('저장된 키가 없으면 api_key 는 unset', async () => {
    const [, apiKey] = await detectProviders(makeProbes({ installed: true }), {})
    expect(apiKey.state).toBe('unset')
    expect(apiKey.maskedKeys).toEqual({})
  })

  it('저장된 키가 있으면 connected + 마스킹만 담는다', async () => {
    const [, apiKey] = await detectProviders(makeProbes({ installed: true }), {
      anthropic: 'sk-ant-••••1234'
    })
    expect(apiKey.state).toBe('connected')
    expect(apiKey.maskedKeys).toEqual({ anthropic: 'sk-ant-••••1234' })
  })

  it('service_credit 은 항상 disabled + 안내 i18n 키', async () => {
    const [, , credit] = await detectProviders(makeProbes({ installed: true }), {})
    expect(credit.state).toBe('disabled')
    expect(credit.detail).toBe(SERVICE_CREDIT_DETAIL_KEY)
    expect(credit.maskedKeys).toEqual({})
  })

  it('claude --version 은 한 번만 실행한다', async () => {
    let calls = 0
    await detectProviders(makeProbes({ installed: true, onVersion: () => (calls += 1) }), {})
    expect(calls).toBe(1)
  })
})

describe('testApiKey', () => {
  it('벤더별 모델 목록을 한 번만 호출하고 ok 만 돌려준다', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ): Promise<{ ok: boolean; status: number }> => {
      seen.push({ url, headers: init?.headers ?? {} })
      return { ok: true, status: 200 }
    }
    const r = await testApiKey('anthropic', 'sk-ant-api03-abcdefgh1234', fetchImpl)
    expect(r).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    // 키는 헤더로만 간다 — URL(쿼리스트링)에 실리지 않는다
    expect(seen[0].url).not.toContain('abcdefgh')
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-api03-abcdefgh1234')
  })

  it('openai · gemini 도 키를 헤더로만 보낸다', async () => {
    const urls: string[] = []
    const headers: Record<string, string>[] = []
    const fetchImpl = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ): Promise<{ ok: boolean; status: number }> => {
      urls.push(url)
      headers.push(init?.headers ?? {})
      return { ok: true, status: 200 }
    }
    await testApiKey('openai', 'sk-proj-zzzzzzzzwxyz', fetchImpl)
    await testApiKey('gemini', 'AIzaSyABCDEFGH9876', fetchImpl)
    expect(urls.every((u) => !u.includes('zzzzzzzz') && !u.includes('ABCDEFGH'))).toBe(true)
    expect(headers[0].Authorization).toBe('Bearer sk-proj-zzzzzzzzwxyz')
    expect(headers[1]['x-goog-api-key']).toBe('AIzaSyABCDEFGH9876')
  })

  it('실패 응답이면 ok:false 이고 본문을 담지 않는다', async () => {
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => ({
      ok: false,
      status: 401
    })
    expect(await testApiKey('anthropic', 'sk-ant-api03-abcdefgh1234', fetchImpl)).toEqual({
      ok: false
    })
  })

  it('네트워크 예외도 ok:false 로 삼킨다', async () => {
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      throw new Error('ENOTFOUND')
    }
    expect(await testApiKey('openai', 'sk-proj-zzzzzzzzwxyz', fetchImpl)).toEqual({ ok: false })
  })

  it('빈 키는 호출조차 하지 않는다', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      calls += 1
      return { ok: true, status: 200 }
    }
    expect(await testApiKey('anthropic', '   ', fetchImpl)).toEqual({ ok: false })
    expect(calls).toBe(0)
  })
})
