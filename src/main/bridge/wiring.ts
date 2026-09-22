// 설정(bridgeEnabled·bridgePort·bridgeToken) → 브릿지 서버 켜기/끄기. handlers 가 설정이 바뀔 때마다 부른다
import { randomBytes } from 'node:crypto'
import type { Settings } from '../../shared/settings'

export interface BridgeServerLike {
  start: (port: number) => Promise<number>
  stop: () => Promise<void>
  listening: () => boolean
}

/** 32바이트 랜덤 → hex 64자 */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex')
}

let currentPort: number | null = null

/**
 * 설정을 서버에 반영한다. 켜져 있는데 토큰이 없으면 만들어 저장(save)한다.
 * 포트가 바뀌었으면 다시 듣고, 꺼져 있으면 멈춘다
 */
export async function applyBridgeSettings(
  server: BridgeServerLike,
  s: Pick<Settings, 'bridgeEnabled' | 'bridgePort' | 'bridgeToken'>,
  save: (patch: { bridgeToken: string }) => void
): Promise<void> {
  if (!s.bridgeEnabled) {
    if (server.listening()) await server.stop()
    currentPort = null
    return
  }
  if (s.bridgeToken === '') save({ bridgeToken: newBridgeToken() })
  if (server.listening() && currentPort === s.bridgePort) return
  try {
    await server.start(s.bridgePort)
    currentPort = s.bridgePort
  } catch (e: unknown) {
    // 포트가 이미 쓰이는 등 — 사유만 남기고 앱은 계속 돈다
    console.error('브릿지 시작 실패', e instanceof Error ? e.message : String(e))
    currentPort = null
  }
}
