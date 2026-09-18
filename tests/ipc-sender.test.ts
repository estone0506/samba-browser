// 렌더러 전용 IPC 채널의 발신자 검증(handlers.ts 가 모든 UI 채널에 적용한다)

import { describe, it, expect } from 'vitest'
import { assertFromRenderer, isFromRenderer, type RendererWindowLike } from '../src/main/ipc/sender'

function win(over: Partial<{ destroyed: boolean; wcDestroyed: boolean }> = {}): RendererWindowLike {
  return {
    isDestroyed: () => over.destroyed ?? false,
    webContents: { id: 1, isDestroyed: () => over.wcDestroyed ?? false }
  }
}

describe('isFromRenderer', () => {
  it('렌더러 창의 webContents 면 허용한다', () => {
    expect(isFromRenderer(win(), { id: 1 })).toBe(true)
  })

  it('탭(웹 페이지)의 webContents 는 거부한다', () => {
    expect(isFromRenderer(win(), { id: 7 })).toBe(false)
  })

  it('발신자를 알 수 없으면 거부한다', () => {
    expect(isFromRenderer(win(), null)).toBe(false)
  })

  it('창이 이미 닫혔으면 거부한다', () => {
    expect(isFromRenderer(win({ destroyed: true }), { id: 1 })).toBe(false)
    expect(isFromRenderer(win({ wcDestroyed: true }), { id: 1 })).toBe(false)
  })
})

describe('assertFromRenderer', () => {
  it('허용된 발신자에게는 아무 일도 하지 않는다', () => {
    expect(() => assertFromRenderer(win(), { id: 1 })).not.toThrow()
  })

  it('페이지 발신자에게는 거부 오류를 던진다', () => {
    expect(() => assertFromRenderer(win(), { id: 7 })).toThrow(/renderer-only/)
  })
})
