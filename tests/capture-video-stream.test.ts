// 녹화 스트리밍 저장(M5) — 청크 쓰기가 실패하면 조용히 지나가지 않고
// 녹화를 멈출 때 사유를 올린다. 부분 쓰기(writeSync 가 요청보다 적게 쓴 경우)도 마저 쓴다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// writeSync 만 갈아 끼운다 — 실패·부분 쓰기를 테스트가 지시한다
const control = vi.hoisted(() => ({ fail: null as string | null, partial: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeSync: (
      fd: number,
      buffer: Uint8Array,
      offset?: number,
      length?: number
    ): number => {
      if (control.fail) throw new Error(control.fail)
      const from = offset ?? 0
      const size = length ?? buffer.byteLength - from
      // 부분 쓰기 흉내 — 한 번에 1바이트만 쓴다
      const take = control.partial ? Math.min(1, size) : size
      return actual.writeSync(fd, buffer, from, take)
    }
  }
})

const { registerCaptureIpc } = await import('../src/main/capture/capture-ipc')
const { IPC } = await import('../src/shared/ipc')

type Handler = (...args: unknown[]) => unknown

let dir = ''
let handlers = new Map<string, Handler>()
let sent: Array<{ channel: string; payload: unknown }> = []

function setup(): void {
  handlers = new Map()
  sent = []
  registerCaptureIpc({
    handle: ((channel: string, fn: Handler) => handlers.set(channel, fn)) as never,
    send: (channel, payload) => sent.push({ channel, payload }),
    settings: () => ({ captureDir: dir, captureFormat: 'png' }) as never,
    setSettings: () => undefined,
    win: {
      isDestroyed: () => false,
      webContents: { setBackgroundThrottling: () => undefined }
    } as never,
    tabs: { active: () => null, hasWebContents: () => false } as never,
    downloadsDir: () => dir
  })
}

const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(...args)

beforeEach(() => {
  control.fail = null
  control.partial = false
  dir = mkdtempSync(join(tmpdir(), 'samba-capture-'))
  setup()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('녹화 청크 쓰기 실패', () => {
  it('중지할 때 사유를 알린다(조용히 삼키지 않는다)', () => {
    const begun = call(IPC.captureBeginVideo) as { token: string }
    control.fail = '디스크가 가득 찼습니다'
    call(IPC.captureAppendVideo, begun.token, new Uint8Array([1, 2, 3]))
    expect(() => call(IPC.captureEndVideo, begun.token, 'videoScreen')).toThrow(/다 쓰지 못했어요/)
    // 실패를 알렸으면 완료 통지는 나가지 않는다
    expect(sent.filter((s) => s.channel === IPC.captureDone)).toHaveLength(0)
  })

  it('실패 사유는 한 번만 올라간다(취소하면 표가 지워진다)', () => {
    const begun = call(IPC.captureBeginVideo) as { token: string }
    control.fail = 'EBADF'
    call(IPC.captureAppendVideo, begun.token, new Uint8Array([1]))
    call(IPC.captureCancelVideo, begun.token)
    expect(() => call(IPC.captureEndVideo, begun.token, 'videoScreen')).not.toThrow()
  })

  it('다음 녹화를 시작하면 앞 녹화의 실패 표는 사라진다', () => {
    const first = call(IPC.captureBeginVideo) as { token: string }
    control.fail = 'EBADF'
    call(IPC.captureAppendVideo, first.token, new Uint8Array([1]))
    control.fail = null
    const second = call(IPC.captureBeginVideo) as { token: string }
    call(IPC.captureAppendVideo, second.token, new Uint8Array([7, 8]))
    expect(() => call(IPC.captureEndVideo, second.token, 'videoScreen')).not.toThrow()
    expect(sent.filter((s) => s.channel === IPC.captureDone)).toHaveLength(1)
  })
})

describe('부분 쓰기', () => {
  it('writeSync 가 요청보다 적게 써도 남은 바이트를 마저 쓴다', () => {
    control.partial = true
    const begun = call(IPC.captureBeginVideo) as { token: string }
    call(IPC.captureAppendVideo, begun.token, new Uint8Array([1, 2, 3, 4, 5]))
    call(IPC.captureEndVideo, begun.token, 'videoScreen')
    const done = sent.find((s) => s.channel === IPC.captureDone) as {
      payload: { filePath: string }
    }
    expect([...readFileSync(done.payload.filePath)]).toEqual([1, 2, 3, 4, 5])
  })
})
