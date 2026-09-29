import { describe, expect, it } from 'vitest'
import { BRIDGE_ACTIVE_WINDOW_MS, BridgeServer } from '../src/main/bridge/server'

// 하네스(브릿지) 자동화 중에도 페이지 대화상자를 자동 처리하도록 '최근 활동' 판정을 못박는다
// (실기 2026-09-25: 하네스가 도는 동안 "옵션을 선택해 주세요" alert 20개가 쌓였다)
describe('BridgeServer.recentlyActive', () => {
  const server = (): BridgeServer =>
    new BridgeServer({} as unknown as ConstructorParameters<typeof BridgeServer>[0])

  it('한 번도 호출이 없으면 자동화 중이 아니다', () => {
    expect(server().recentlyActive()).toBe(false)
  })

  it('마지막 호출 뒤 창 안이면 자동화 중, 지나면 아니다', () => {
    const s = server()
    const at = 1_000_000
    ;(s as unknown as { lastActivityAt: number }).lastActivityAt = at
    expect(s.recentlyActive(BRIDGE_ACTIVE_WINDOW_MS, at + BRIDGE_ACTIVE_WINDOW_MS - 1)).toBe(true)
    expect(s.recentlyActive(BRIDGE_ACTIVE_WINDOW_MS, at + BRIDGE_ACTIVE_WINDOW_MS + 1)).toBe(false)
  })

  it('호출 중(busy)이면 시간과 상관없이 자동화 중', () => {
    const s = server()
    ;(s as unknown as { busy: boolean }).busy = true
    expect(s.recentlyActive(1, Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})
