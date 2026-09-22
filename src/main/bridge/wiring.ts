// 설정(bridgeEnabled·bridgePort·bridgeToken) → 브릿지 서버 켜기/끄기. handlers 가 설정이 바뀔 때마다 부른다
import { randomBytes } from 'node:crypto'
import type { Settings } from '../../shared/settings'

export interface BridgeServerLike {
  start: (port: number) => Promise<number>
  stop: () => Promise<void>
  listening: () => boolean
  address: () => { address: string; port: number } | null
}

/** 32바이트 랜덤 → hex 64자 */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex')
}

type BridgeSettingsSlice = Pick<Settings, 'bridgeEnabled' | 'bridgePort' | 'bridgeToken'>

// 호출을 한 줄로 잇는 큐 — applyBridgeSettings 가 겹쳐 불려도(설정이 빠르게 여러 번 바뀌어도)
// 이전 호출이 끝난 뒤에 다음 호출이 시작되게 한다. 레이스로 포트가 엇갈리는 걸 막는다
let queue = Promise.resolve()

/**
 * 설정을 서버에 반영한다. 켜져 있는데 토큰이 없으면 만들어 저장(save)한다.
 * 포트가 바뀌었으면 다시 듣고, 꺼져 있으면 멈춘다
 */
export function applyBridgeSettings(
  server: BridgeServerLike,
  getSettings: () => BridgeSettingsSlice,
  save: (patch: { bridgeToken: string }) => void
): Promise<void> {
  queue = queue.then(() => doApply(server, getSettings, save)).catch(() => undefined)
  return queue
}

async function doApply(
  server: BridgeServerLike,
  getSettings: () => BridgeSettingsSlice,
  save: (patch: { bridgeToken: string }) => void
): Promise<void> {
  const s = getSettings()
  if (!s.bridgeEnabled) {
    if (server.listening()) await server.stop()
    return
  }
  if (s.bridgeToken === '') save({ bridgeToken: newBridgeToken() })
  const currentPort = server.address()?.port ?? null
  if (server.listening() && currentPort === s.bridgePort) return
  try {
    await server.start(s.bridgePort)
    // 시작하는 동안 설정이 또 바뀌었을 수 있다 — 그새 꺼졌으면 곧바로 멈춘다
    const after = getSettings()
    if (!after.bridgeEnabled) await server.stop()
  } catch (e: unknown) {
    // 포트가 이미 쓰이는 등 — 사유만 남기고 앱은 계속 돈다
    console.error('브릿지 시작 실패', e instanceof Error ? e.message : String(e))
  }
}
