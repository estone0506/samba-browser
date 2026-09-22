// 설정에 따라 브릿지를 켜고 끄고, 토큰이 없으면 만든다
import { describe, it, expect, vi } from 'vitest'
import { applyBridgeSettings, newBridgeToken } from '../src/main/bridge/wiring'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

function fakeServer(): {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  listening: () => boolean
  address: () => { address: string; port: number } | null
  port: number | null
} {
  const s = {
    port: null as number | null,
    start: vi.fn(async (p: number) => {
      s.port = p
      return p
    }),
    stop: vi.fn(async () => {
      s.port = null
    }),
    listening: () => s.port !== null,
    address: () => (s.port === null ? null : { address: '127.0.0.1', port: s.port })
  }
  return s
}

describe('applyBridgeSettings', () => {
  it('켜면 토큰을 만들어 저장하고 그 포트로 듣는다', async () => {
    const server = fakeServer()
    const saved: Record<string, unknown>[] = []
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true }),
      (p) => saved.push(p)
    )
    expect(server.start).toHaveBeenCalledWith(47811)
    expect(saved).toHaveLength(1)
    expect(String(saved[0].bridgeToken)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('토큰이 이미 있으면 다시 만들지 않는다', async () => {
    const server = fakeServer()
    const saved: unknown[] = []
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }),
      (p) => saved.push(p)
    )
    expect(saved).toHaveLength(0)
  })

  it('끄면 멈추고, 포트가 바뀌면 다시 듣는다', async () => {
    const server = fakeServer()
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }),
      () => {}
    )
    await applyBridgeSettings(
      server,
      () => ({
        ...DEFAULT_SETTINGS,
        bridgeEnabled: true,
        bridgeToken: 'f'.repeat(64),
        bridgePort: 47900
      }),
      () => {}
    )
    expect(server.start).toHaveBeenLastCalledWith(47900)
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: false, bridgeToken: 'f'.repeat(64) }),
      () => {}
    )
    expect(server.stop).toHaveBeenCalled()
    expect(server.listening()).toBe(false)
  })

  it('호출이 겹쳐도 순서대로 처리된다(레이스 없음)', async () => {
    const server = fakeServer()
    let s = { ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }
    const getSettings = (): typeof s => s
    const p1 = applyBridgeSettings(server, getSettings, () => {})
    s = { ...s, bridgePort: 48000 }
    const p2 = applyBridgeSettings(server, getSettings, () => {})
    await Promise.all([p1, p2])
    expect(server.start).toHaveBeenLastCalledWith(48000)
    expect(server.listening()).toBe(true)
  })

  it('새 토큰은 64자 hex 다', () => {
    expect(newBridgeToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newBridgeToken()).not.toBe(newBridgeToken())
  })
})
