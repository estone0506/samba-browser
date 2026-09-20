// @vitest-environment jsdom
// 녹화 핸들(M6) — 청크를 파일로 흘려 보낼 때는 메모리에 또 쌓지 않고,
// recorder.onerror 는 stop() 을 기다리지 않고 시작할 때부터 걸려 있어야 한다

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { startRecording } from '../src/renderer/src/lib/capture-video'

type Listener = ((e: Event) => void) | null

class FakeMediaRecorder {
  static isTypeSupported = (): boolean => true
  state = 'recording'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: Listener = null
  onerror: Listener = null
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.onstop?.(new Event('stop'))
  }
  /** 테스트가 청크를 직접 밀어 넣는다 */
  emit(bytes: number[]): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) })
  }
  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

let recorder: FakeMediaRecorder

const SOURCE = {
  sourceId: 'screen:0',
  width: 100,
  height: 100,
  crop: null,
  viewport: null,
  scaleFactor: 1
}

const stopped: string[] = []

beforeEach(() => {
  stopped.length = 0
  vi.stubGlobal(
    'MediaRecorder',
    class extends FakeMediaRecorder {
      constructor() {
        super()
        recorder = this
      }
    }
  )
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: (): void => void stopped.push('screen') }],
        getAudioTracks: () => [],
        addTrack: (): void => undefined
      })
    }
  })
})

describe('startRecording — 청크 보관', () => {
  it('onChunk 가 있으면 메모리에 쌓지 않고 빈 바이트를 돌려준다', async () => {
    const seen: number[][] = []
    const handle = await startRecording({
      source: SOURCE as never,
      microphone: false,
      onChunk: (bytes) => seen.push([...bytes])
    })
    recorder.emit([1, 2, 3])
    const result = await handle.stop()
    expect(seen).toEqual([[1, 2, 3]])
    // 파일로 흘려 보냈으므로 렌더러 메모리에는 복사본이 없다
    expect(result.byteLength).toBe(0)
    expect(stopped).toContain('screen')
  })

  it('onChunk 가 없으면 예전처럼 모아 둔 바이트를 돌려준다', async () => {
    const handle = await startRecording({ source: SOURCE as never, microphone: false })
    recorder.emit([9, 9])
    const result = await handle.stop()
    expect(result.byteLength).toBe(2)
  })
})

describe('startRecording — recorder.onerror', () => {
  it('stop() 전에 난 오류도 정리하고, stop() 은 그 오류로 실패한다', async () => {
    const handle = await startRecording({ source: SOURCE as never, microphone: false })
    recorder.fail()
    // 오류 시점에 스트림 정리가 이미 끝나 있다
    expect(stopped).toContain('screen')
    await expect(handle.stop()).rejects.toThrow('녹화 중 오류가 났어요')
  })

  it('stop() 을 기다리는 중에 난 오류도 올라온다', async () => {
    const handle = await startRecording({ source: SOURCE as never, microphone: false })
    const pending = handle.stop()
    recorder.fail()
    await expect(pending).rejects.toThrow('녹화 중 오류가 났어요')
  })
})
