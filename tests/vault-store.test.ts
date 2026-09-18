import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcResult, VaultState } from '../src/shared/ipc'

// 렌더러 전역 window.samba 스텁. unlockOnly 가 settings.set 을 호출하지 않는지,
// unlock(m, true) 는 호출하는지를 확인하는 게 이 테스트의 핵심이다
const settingsSet = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
const vaultUnlock = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
const vaultState = vi.fn(async (): Promise<IpcResult<VaultState>> => ({
  ok: true,
  data: 'unlocked'
}))
const vaultSites = vi.fn(async () => ({ ok: true, data: [] }))
const vaultAccounts = vi.fn(async () => ({ ok: true, data: [] }))

const win = {
  samba: {
    settings: { set: settingsSet },
    vault: {
      unlock: vaultUnlock,
      state: vaultState,
      sites: vaultSites,
      accounts: vaultAccounts,
      onCapturePrompt: vi.fn(),
      captureDecision: vi.fn()
    }
  }
}
Object.assign(globalThis, { window: win })

const { useVaultStore } = await import('../src/renderer/src/stores/vaultStore')

describe('vaultStore 잠금 해제', () => {
  beforeEach(() => {
    settingsSet.mockClear()
    vaultUnlock.mockClear()
    vaultUnlock.mockImplementation(async () => ({ ok: true, data: true }))
    useVaultStore.setState({
      state: 'locked',
      loading: false,
      error: null,
      capture: null,
      captureUnlocking: false,
      capturePw: '',
      captureErr: null
    })
  })

  it('unlockOnly 는 settings.set 을 호출하지 않는다', async () => {
    const ok = await useVaultStore.getState().unlockOnly('master-pw')
    expect(ok).toBe(true)
    expect(vaultUnlock).toHaveBeenCalledWith('master-pw')
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('unlock(m, true) 는 settings.set 을 호출한다', async () => {
    const ok = await useVaultStore.getState().unlock('master-pw', true)
    expect(ok).toBe(true)
    expect(vaultUnlock).toHaveBeenCalledWith('master-pw')
    expect(settingsSet).toHaveBeenCalledWith({ vaultRememberDevice: true })
  })

  it('unlockOnly 실패 시 false 를 반환하고 settings.set 은 여전히 호출되지 않는다', async () => {
    vaultUnlock.mockImplementationOnce(async () => ({ ok: false, error: 'invalid' }))
    const ok = await useVaultStore.getState().unlockOnly('wrong-pw')
    expect(ok).toBe(false)
    expect(settingsSet).not.toHaveBeenCalled()
  })
})

describe('vaultStore capture 상태 초기화', () => {
  beforeEach(() => {
    useVaultStore.setState({
      capture: null,
      captureUnlocking: false,
      capturePw: '',
      captureErr: null
    })
  })

  it('host/username 이 다른 새 capture 가 오면 인라인 잠금 해제 폼 상태를 초기화한다', () => {
    useVaultStore.setState({ capturePw: 'typed', captureUnlocking: true, captureErr: 'err' })
    useVaultStore.getState().setCapture({ host: 'a.com', username: 'alice', isNew: true })

    useVaultStore.setState({ capturePw: 'typed-again', captureUnlocking: true, captureErr: 'err2' })
    useVaultStore.getState().setCapture({ host: 'b.com', username: 'bob', isNew: true })

    const s = useVaultStore.getState()
    expect(s.capture).toEqual({ host: 'b.com', username: 'bob', isNew: true })
    expect(s.capturePw).toBe('')
    expect(s.captureUnlocking).toBe(false)
    expect(s.captureErr).toBeNull()
  })

  it('같은 host/username 의 capture 재수신은 폼 상태를 건드리지 않는다', () => {
    useVaultStore.getState().setCapture({ host: 'a.com', username: 'alice', isNew: true })
    useVaultStore.setState({ capturePw: 'typed', captureUnlocking: true })

    useVaultStore.getState().setCapture({ host: 'a.com', username: 'alice', isNew: true })

    const s = useVaultStore.getState()
    expect(s.capturePw).toBe('typed')
    expect(s.captureUnlocking).toBe(true)
  })

  it('decideCapture 는 capture 와 폼 상태를 모두 정리한다', () => {
    useVaultStore.getState().setCapture({ host: 'a.com', username: 'alice', isNew: true })
    useVaultStore.setState({ capturePw: 'typed', captureUnlocking: true, captureErr: 'err' })

    useVaultStore.getState().decideCapture(true)

    const s = useVaultStore.getState()
    expect(s.capture).toBeNull()
    expect(s.capturePw).toBe('')
    expect(s.captureUnlocking).toBe(false)
    expect(s.captureErr).toBeNull()
  })
})
