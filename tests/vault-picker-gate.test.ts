// 페이지 내 자동 채움 피커 게이트 — 발신자 검증·레이트리밋·호스트 대조·잠금 처리 검증.
// 이 경로로는 비밀값이 오가지 않는다는 점도 함께 단언한다.

import { describe, it, expect, vi } from 'vitest'
import {
  VaultPickerGate,
  PICKER_MAX_PER_WINDOW,
  PICKER_WINDOW_MS,
  type PickerVaultLike
} from '../src/main/ipc/vault-picker'
import type { VaultState } from '../src/shared/vault'

const FRAME = { trusted: true, frameUrl: 'https://www.shop.example/login' }

interface Built {
  gate: VaultPickerGate
  listPickerAccounts: ReturnType<typeof vi.fn>
  tick: (ms: number) => void
}

function build(
  opts: { state?: VaultState; excludedHosts?: string[]; accounts?: unknown[] } = {}
): Built {
  let clock = 1_000_000
  const listPickerAccounts = vi.fn(() => [{ id: 1, label: '메인', username: 'alice' }])
  const vault: PickerVaultLike = {
    state: () => opts.state ?? 'unlocked',
    listPickerAccounts: listPickerAccounts as unknown as PickerVaultLike['listPickerAccounts']
  }
  const gate = new VaultPickerGate({
    vault,
    excludedHosts: () => opts.excludedHosts ?? [],
    now: () => clock
  })
  return {
    gate,
    listPickerAccounts,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('VaultPickerGate.accounts', () => {
  it('정상 요청이면 계정 목록을 돌려준다', () => {
    const b = build()
    const result = b.gate.accounts({}, FRAME, 'shop.example')
    expect(result.outcome).toBe('ok')
    expect(result.accounts).toEqual([{ id: 1, label: '메인', username: 'alice' }])
    // 호스트는 발신 프레임 URL 에서 정규화한 값을 쓴다(페이지가 준 문자열이 아니다)
    expect(b.listPickerAccounts).toHaveBeenCalledWith('shop.example')
  })

  it('탭이 아닌 발신자는 거부한다(위조 발신자)', () => {
    const b = build()
    const result = b.gate.accounts({}, { ...FRAME, trusted: false }, 'shop.example')
    expect(result.outcome).toBe('untrusted-sender')
    expect(result.accounts).toEqual([])
    expect(b.listPickerAccounts).not.toHaveBeenCalled()
  })

  it('프레임 URL 과 다른 호스트를 주장하면 거부한다', () => {
    const b = build()
    const result = b.gate.accounts({}, FRAME, 'bank.example')
    expect(result.outcome).toBe('host-mismatch')
    expect(result.accounts).toEqual([])
  })

  it('프레임 URL 을 알 수 없으면 거부한다', () => {
    const b = build()
    const result = b.gate.accounts({}, { trusted: true, frameUrl: '' }, 'shop.example')
    expect(result.outcome).toBe('host-mismatch')
  })

  it('제외 도메인은 목록 자체를 내보내지 않는다', () => {
    const b = build({ excludedHosts: ['shop.example'] })
    const result = b.gate.accounts({}, FRAME, 'shop.example')
    expect(result.outcome).toBe('excluded')
    expect(result.accounts).toEqual([])
  })

  it('제외 도메인의 서브도메인(login.shop.example)도 목록을 내보내지 않는다', () => {
    const b = build({ excludedHosts: ['shop.example'] })
    const frame = { ...FRAME, frameUrl: 'https://login.shop.example/signin' }
    const result = b.gate.accounts({}, frame, 'login.shop.example')
    expect(result.outcome).toBe('excluded')
  })

  it('잠겨 있으면 빈 목록과 locked 를 돌려준다(드롭다운이 안내 문구를 띄운다)', () => {
    const b = build({ state: 'locked' })
    const result = b.gate.accounts({}, FRAME, 'shop.example')
    expect(result.outcome).toBe('locked')
    expect(result.accounts).toEqual([])
  })

  it('창 안에서 상한을 넘으면 막고, 창이 지나면 다시 받는다', () => {
    const b = build()
    const sender = {}
    for (let i = 0; i < PICKER_MAX_PER_WINDOW; i++) {
      expect(b.gate.accounts(sender, FRAME, 'shop.example').outcome).toBe('ok')
    }
    expect(b.gate.accounts(sender, FRAME, 'shop.example').outcome).toBe('rate-limited')
    // 피커는 입력칸을 누를 때마다 열려 30초/60회로 넉넉히 잡는다(정상 사용이 막히면 안 된다)
    expect(PICKER_MAX_PER_WINDOW).toBe(60)
    b.tick(PICKER_WINDOW_MS + 1)
    expect(b.gate.accounts(sender, FRAME, 'shop.example').outcome).toBe('ok')
  })

  it('레이트리밋은 발신자(탭)별로 따로 센다', () => {
    const b = build()
    const a = {}
    const c = {}
    for (let i = 0; i < PICKER_MAX_PER_WINDOW; i++) b.gate.accounts(a, FRAME, 'shop.example')
    expect(b.gate.accounts(a, FRAME, 'shop.example').outcome).toBe('rate-limited')
    expect(b.gate.accounts(c, FRAME, 'shop.example').outcome).toBe('ok')
  })
})

describe('VaultPickerGate.fill', () => {
  it('정상 요청이면 accountId 와 검증된 호스트를 돌려준다', () => {
    const b = build()
    const result = b.gate.fill({}, FRAME, { accountId: 7 })
    expect(result).toEqual({ outcome: 'ok', accountId: 7, host: 'shop.example' })
  })

  it('형식이 어긋난 payload 는 거부한다', () => {
    const b = build()
    expect(b.gate.fill({}, FRAME, { accountId: -1 }).outcome).toBe('invalid')
    expect(b.gate.fill({}, FRAME, { accountId: 'x' }).outcome).toBe('invalid')
    expect(b.gate.fill({}, FRAME, null).outcome).toBe('invalid')
  })

  it('위조 발신자·잠금 상태는 채우지 않는다', () => {
    expect(build().gate.fill({}, { ...FRAME, trusted: false }, { accountId: 1 }).outcome).toBe(
      'untrusted-sender'
    )
    expect(build({ state: 'locked' }).gate.fill({}, FRAME, { accountId: 1 }).outcome).toBe('locked')
  })
})
