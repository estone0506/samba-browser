// 화면 녹화 스토어의 연타 방지. 브라우저 API(MediaRecorder)는 쓰지 않고
// window.samba 와 녹화 시작 함수를 스텁으로 갈아 끼운다

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 녹화 시작(getUserMedia·MediaRecorder)은 node 에서 못 돌린다 — 스텁으로 바꾼다
const { startRecording, cropDataUrl } = vi.hoisted(() => ({
  startRecording: vi.fn(async () => ({ stop: async (): Promise<void> => {} })),
  cropDataUrl: vi.fn(async () => 'data:image/png;base64,')
}))
vi.mock('@renderer/lib/capture-video', () => ({ startRecording, cropDataUrl }))
vi.mock('@renderer/stores/uiStore', () => ({
  useUiStore: { getState: () => ({ setCaptureOverlayOpen: (): void => {} }) }
}))
vi.mock('../src/renderer/src/stores/uiStore', () => ({
  useUiStore: { getState: () => ({ setCaptureOverlayOpen: (): void => {} }) }
}))

// beginVideo 는 일부러 느리게 답한다 — 이 틈에 들어온 두 번째 호출이 막혀야 한다
let beginDelayMs = 0
const beginVideo = vi.fn(async (): Promise<{ ok: true; data: { token: string } }> => {
  if (beginDelayMs > 0) await new Promise((r) => setTimeout(r, beginDelayMs))
  return { ok: true, data: { token: `t${beginVideo.mock.calls.length}` } }
})
const videoSource = vi.fn(async () => ({
  ok: true as const,
  data: { id: 'screen:0', viewport: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }
}))
const appendVideo = vi.fn(async () => ({ ok: true as const, data: undefined }))
const endVideo = vi.fn(async () => ({ ok: true as const, data: undefined }))
const cancelVideo = vi.fn(async () => ({ ok: true as const, data: undefined }))
const still = vi.fn(async () => ({
  ok: true as const,
  data: { dataUrl: 'data:image/png;base64,', width: 800, height: 600, scale: 1 }
}))
const run = vi.fn(async () => ({ ok: true as const, data: undefined }))
const settingsGet = vi.fn(async () => ({
  ok: true as const,
  data: { captureMicrophone: false, captureFormat: 'png' }
}))

Object.assign(globalThis, {
  window: {
    samba: {
      settings: { get: settingsGet },
      capture: { beginVideo, appendVideo, endVideo, cancelVideo, videoSource, still, run }
    },
    setInterval: (): number => 0,
    clearInterval: (): void => {},
    setTimeout: (fn: () => void, ms?: number): unknown => setTimeout(fn, ms)
  }
})

const { useCaptureStore, RECORDING_BUSY_KEY } =
  await import('../src/renderer/src/stores/captureStore')

const store = (): ReturnType<typeof useCaptureStore.getState> => useCaptureStore.getState()

beforeEach(async () => {
  // 앞 테스트의 녹화를 정리한다(모듈 바깥 표식까지 함께 풀린다)
  if (store().recordingMode) await store().stopRecording()
  useCaptureStore.setState({ recordingMode: null, error: null, still: null, stillMode: null })
  beginDelayMs = 0
  beginVideo.mockClear()
  cancelVideo.mockClear()
  startRecording.mockClear()
})

describe('captureStore 녹화 연타', () => {
  it('시작 절차가 끝나기 전에 다시 부르면 RECORDING_BUSY_KEY 로 거절한다', async () => {
    beginDelayMs = 20
    const first = store().start('videoScreen')
    // 두 번째 호출은 첫 호출이 await 에 걸려 있는 동안 들어온다
    await store().start('videoScreen')
    expect(store().error).toBe(RECORDING_BUSY_KEY)
    await first
    // 파일은 한 번만 열린다(0바이트 파일이 생기지 않는다)
    expect(beginVideo).toHaveBeenCalledTimes(1)
    expect(store().recordingMode).toBe('videoScreen')
  })

  it('녹화 중에 다시 시작하려 해도 거절한다', async () => {
    await store().start('videoScreen')
    expect(store().recordingMode).toBe('videoScreen')
    await store().start('videoScreen')
    expect(store().error).toBe(RECORDING_BUSY_KEY)
    expect(beginVideo).toHaveBeenCalledTimes(1)
  })

  it('거절당한 호출은 앞선 시작의 표식을 풀지 않는다(연달아 세 번 눌러도 1회)', async () => {
    beginDelayMs = 20
    const first = store().start('videoScreen')
    await store().start('videoScreen')
    await store().start('videoScreen')
    await first
    expect(beginVideo).toHaveBeenCalledTimes(1)
  })

  it('이미지 캡처는 녹화 중에도 막히지 않는다', async () => {
    await store().start('videoScreen')
    run.mockClear()
    await store().start('fullScreen')
    expect(store().error).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('시작이 실패하면 표식을 풀어 다시 시도할 수 있다', async () => {
    videoSource.mockImplementationOnce(
      async () => ({ ok: false, error: '화면 소스를 찾지 못했습니다' }) as never
    )
    await store().start('videoScreen')
    expect(store().error).toBe('화면 소스를 찾지 못했습니다')
    await store().start('videoScreen')
    expect(store().recordingMode).toBe('videoScreen')
  })
})
