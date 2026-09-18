import { describe, it, expect, vi } from 'vitest'
import {
  VaultCaptureGate,
  CAPTURE_MAX_PER_WINDOW,
  CAPTURE_WINDOW_MS,
  type CaptureVaultLike
} from '../src/main/ipc/vault-capture'
import type { VaultState } from '../src/shared/vault'

const PASSWORD = 'sup3r-secret-pw!'
const PAYLOAD = { host: 'shop.example', username: 'alice', password: PASSWORD }
const FRAME = { trusted: true, frameUrl: 'https://www.shop.example/login' }

interface Built {
  gate: VaultCaptureGate
  setPendingCapture: ReturnType<typeof vi.fn>
  hasSameSecret: ReturnType<typeof vi.fn>
  tick: (ms: number) => void
}

function build(
  opts: {
    state?: VaultState
    excludedHosts?: string[]
    sameSecret?: boolean
    accounts?: { username: string }[]
  } = {}
): Built {
  let clock = 1_000_000
  const setPendingCapture = vi.fn()
  const hasSameSecret = vi.fn(() => opts.sameSecret ?? false)
  const vault: CaptureVaultLike = {
    state: () => opts.state ?? 'unlocked',
    hasSameSecret,
    listAccounts: () => opts.accounts ?? [],
    setPendingCapture
  }
  const gate = new VaultCaptureGate({
    vault,
    excludedHosts: () => opts.excludedHosts ?? [],
    now: () => clock
  })
  return {
    gate,
    setPendingCapture,
    hasSameSecret,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('VaultCaptureGate', () => {
  it('정상 요청은 저장 제안을 띄운다(신규 계정)', () => {
    const b = build()
    const sender = {}
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith({
      host: 'shop.example',
      username: 'alice',
      password: PASSWORD,
      isNew: true,
      locked: false
    })
  })

  it('발신자가 탭의 webContents 가 아니면 무시한다(위조 발신자)', () => {
    const b = build()
    expect(b.gate.handle({}, { ...FRAME, trusted: false }, PAYLOAD)).toBe('untrusted-sender')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
    // 위조 발신자는 레이트리밋 카운터도 소비하지 않는다
    expect(b.hasSameSecret).not.toHaveBeenCalled()
  })

  it('sender 당 30초에 3회까지만 받고, 창이 지나면 다시 받는다', () => {
    const b = build()
    const sender = {}
    for (let i = 0; i < CAPTURE_MAX_PER_WINDOW; i++) {
      expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
    }
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('rate-limited')
    expect(b.setPendingCapture).toHaveBeenCalledTimes(CAPTURE_MAX_PER_WINDOW)

    // 다른 sender 는 자기 몫의 한도를 따로 가진다
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')

    b.tick(CAPTURE_WINDOW_MS + 1)
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
  })

  it('payload 의 host 가 발신 프레임 호스트와 다르면 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, FRAME, { ...PAYLOAD, host: 'evil.example' })).toBe('host-mismatch')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('프레임 URL 을 알 수 없으면 대조할 수 없으므로 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, { trusted: true, frameUrl: '' }, PAYLOAD)).toBe('host-mismatch')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('스키마에 맞지 않으면 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, FRAME, { host: 'shop.example', username: 'alice' })).toBe('invalid')
    expect(b.gate.handle({}, FRAME, 'not-an-object')).toBe('invalid')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('제외 도메인이면 제안하지 않는다', () => {
    const b = build({ excludedHosts: ['www.shop.example'] })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('excluded')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('이미 같은 값이 저장돼 있으면 제안하지 않는다', () => {
    const b = build({ sameSecret: true })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('duplicate')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('기존 계정이면 isNew=false 로 제안한다', () => {
    const b = build({ accounts: [{ username: 'alice' }] })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ isNew: false, locked: false })
    )
  })

  it('잠긴 상태에서는 locked=true 로 제안한다(문구 분기용)', () => {
    const b = build({ state: 'locked' })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ isNew: true, locked: true })
    )
    expect(b.hasSameSecret).not.toHaveBeenCalled()
  })

  it('반환값에는 비밀번호가 담기지 않는다', () => {
    const b = build()
    const outcome = b.gate.handle({}, FRAME, PAYLOAD)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })
})
