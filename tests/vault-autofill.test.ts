// 사용자 조작 자동 채움(상세 화면 버튼·페이지 내 피커)의 호스트 대조 검증.
// pageBridge 는 mock 으로 대체해 electron 없이 실행한다.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { VaultService } from '../src/main/vault/service'
import type { AccountDto } from '../src/shared/vault'

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    findLoginFields: vi.fn(
      async (): Promise<{
        username: number | undefined
        password: number | undefined
        submit: number | undefined
      }> => ({ username: 1, password: 2, submit: 3 })
    ),
    fillValue: vi.fn(async (): Promise<string> => 'ok'),
    submitForm: vi.fn(async (): Promise<string> => 'ok')
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { autofillAccount } = await import('../src/main/vault/autofill')

const PASSWORD = 'pw-secret-1234'

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host: 'nid.naver.com',
    label: '네이버',
    username: 'hongildong',
    isDefault: true,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: [],
    ...over
  }
}

function tabAt(url: string): Tab {
  return { id: 't1', view: { webContents: { getURL: () => url } } } as unknown as Tab
}

function deps(
  opts: { url?: string; account?: AccountDto | null; excluded?: string[]; locked?: boolean } = {}
): {
  vault: VaultService
  activeTab: () => Tab | null
  excludedHosts: () => string[]
} {
  const vault = {
    state: () => (opts.locked ? 'locked' : 'unlocked'),
    getAccount: () => (opts.account === undefined ? account() : opts.account),
    getSecretForFill: () => PASSWORD
  } as unknown as VaultService
  return {
    vault,
    activeTab: () => (opts.url === null ? null : tabAt(opts.url ?? 'https://www.naver.com/')),
    excludedHosts: () => opts.excluded ?? []
  }
}

beforeEach(() => {
  pageBridge.fillValue.mockClear()
  pageBridge.findLoginFields.mockClear()
})

describe('autofillAccount', () => {
  it('같은 등록 도메인이면 서브도메인이 달라도 채운다(nid.naver.com 계정 → www.naver.com)', async () => {
    expect(await autofillAccount(deps(), 1)).toBe('ok')
    expect(pageBridge.fillValue).toHaveBeenCalledTimes(2)
  })

  it('autoSubmit 이 켜져 있고 아이디까지 채웠으면 로그인 폼을 바로 제출한다', async () => {
    pageBridge.submitForm.mockClear()
    expect(await autofillAccount({ ...deps(), autoSubmit: () => true }, 1)).toBe('ok')
    expect(pageBridge.submitForm).toHaveBeenCalledTimes(1)
  })

  it('autoSubmit 이 꺼져 있으면 채우기만 한다', async () => {
    pageBridge.submitForm.mockClear()
    expect(await autofillAccount({ ...deps(), autoSubmit: () => false }, 1)).toBe('ok')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('등록 도메인이 다르면 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ url: 'https://www.daum.net/login' }), 1)).toBe(
      'host-mismatch'
    )
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('평문(http) 페이지에는 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ url: 'http://www.naver.com/' }), 1)).toBe('insecure-page')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('제외 도메인이면 채우지 않는다(같은 등록 도메인의 서브도메인 포함)', async () => {
    expect(await autofillAccount(deps({ excluded: ['naver.com'] }), 1)).toBe('excluded')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('금고가 잠겨 있으면 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ locked: true }), 1)).toBe('locked')
  })

  it('target 을 주면 활성 탭이 아니라 그 탭에 채운다(피커 경로)', async () => {
    const target = tabAt('https://nid.naver.com/nidlogin.login')
    const d = deps({ url: 'https://www.daum.net/' })
    expect(await autofillAccount(d, 1, { tab: target, host: 'nid.naver.com' })).toBe('ok')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(1, target, 1, 'hongildong')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(2, target, 2, PASSWORD)
  })

  it('게이트가 검증한 호스트와 탭의 현재 호스트가 어긋나면 채우지 않는다', async () => {
    const target = tabAt('https://www.daum.net/login')
    expect(await autofillAccount(deps(), 1, { tab: target, host: 'nid.naver.com' })).toBe(
      'host-mismatch'
    )
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('아이디 칸이 있는데 금고 아이디가 비어 있으면 제출하지 않는다(빈 아이디 제출 금지)', async () => {
    pageBridge.submitForm.mockClear()
    const d = { ...deps({ account: account({ username: '' }) }), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('filled-password-only')
    // 비밀번호 칸만 채우고 아이디 칸은 건드리지 않는다
    expect(pageBridge.fillValue).toHaveBeenCalledTimes(1)
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('아이디 칸 자체가 없는 비밀번호 전용 화면(2단계)이면 제출한다', async () => {
    pageBridge.submitForm.mockClear()
    pageBridge.findLoginFields.mockResolvedValueOnce({
      username: undefined,
      password: 2,
      submit: 3
    })
    const d = { ...deps({ account: account({ username: '' }) }), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('ok')
    expect(pageBridge.submitForm).toHaveBeenCalledTimes(1)
  })

  it('아이디 채우기가 실패하면 제출하지 않는다', async () => {
    pageBridge.submitForm.mockClear()
    pageBridge.fillValue.mockResolvedValueOnce('not found')
    const d = { ...deps(), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('filled-password-only')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('계정을 찾지 못하면 값을 읽지 않는다', async () => {
    expect(await autofillAccount(deps({ account: null }), 99)).toBe('account-not-found')
    expect(pageBridge.findLoginFields).not.toHaveBeenCalled()
  })
})
