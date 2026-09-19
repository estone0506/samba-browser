import { create } from 'zustand'
import {
  isVideoCaptureMode,
  normalizeDragRect,
  videoRegionCrop,
  type CaptureMode,
  type CaptureResultDto,
  type CaptureStillDto,
  type CaptureVideoSourceDto
} from '@shared/capture'
import { cropDataUrl, startRecording, type RecordingHandle } from '@renderer/lib/capture-video'
import { useUiStore } from './uiStore'

// 녹화 중인 작업. 핸들은 스토어 상태에 넣지 않는다(리렌더 대상이 아니다)
// 녹화 중 새 녹화를 시작하려 할 때의 오류 표식(렌더러가 i18n 문구로 바꿔 보여 준다)
export const RECORDING_BUSY_KEY = 'screenCapture.recordingBusy'

let recordingHandle: RecordingHandle | null = null
// 녹화 청크 이어 쓰기 대기열(중지 때 마지막 청크까지 기다린다)
let appendQueue: () => Promise<unknown> = () => Promise.resolve()
let elapsedTimer: number | null = null
// 비디오 '직접 지정' 에서 오버레이를 띄우기 직전에 받아 둔 화면 소스.
// 오버레이가 열리면 웹뷰가 접혀 웹뷰 좌표를 다시 잴 수 없으므로 미리 받아 둔다
let pendingVideoSource: CaptureVideoSourceDto | null = null

export interface CaptureState {
  /** 직접 지정 오버레이에 띄운 정지 이미지. null 이면 오버레이가 닫혀 있다 */
  still: CaptureStillDto | null
  /** 오버레이를 연 캡처 방식('direct' 는 이미지 저장, 'videoDirect' 는 녹화 시작) */
  stillMode: CaptureMode | null
  /** 녹화 중인 방식. null 이면 녹화 중이 아니다 */
  recordingMode: CaptureMode | null
  /** 녹화 경과 시간(초) */
  elapsed: number
  /** 저장 직후 미리보기 토스트 */
  toast: CaptureResultDto | null
  /** 마지막 오류 문구(메뉴 아래에 잠깐 보여 준다) */
  error: string | null
  start: (mode: CaptureMode) => Promise<void>
  closeStill: () => void
  /** 오버레이에서 드래그가 끝났을 때. 좌표는 정지 이미지 안의 CSS 픽셀 */
  cropAndSave: (a: { x: number; y: number }, b: { x: number; y: number }) => Promise<void>
  /** 오버레이에서 고른 사각 영역만 녹화한다(비디오 · 직접 지정) */
  recordRegion: (a: { x: number; y: number }, b: { x: number; y: number }) => Promise<void>
  stopRecording: () => Promise<void>
  showToast: (dto: CaptureResultDto) => void
  dismissToast: () => void
  clearError: () => void
}

// 웹뷰가 오버레이를 덮지 않도록 접었다 펴는 스위치(uiStore.resizing 과 같은 방식)
function setWebviewCollapsed(collapsed: boolean): void {
  useUiStore.getState().setCaptureOverlayOpen(collapsed)
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 녹화를 시작한다(전체 화면·직접 지정 공통).
 * 파일을 먼저 열어 두고 청크를 바로 이어 쓴다 — 앱이 죽어도 직전까지 남는다
 */
async function beginRecording(
  mode: CaptureMode,
  source: CaptureVideoSourceDto,
  onStarted: () => void
): Promise<void> {
  const settings = await window.samba.settings.get()
  const begun = await window.samba.capture.beginVideo(mode)
  if (!begun.ok) throw new Error(begun.error)
  // 청크는 순서가 중요하므로 앞 청크 쓰기가 끝난 뒤 다음을 보낸다
  let queue: Promise<unknown> = Promise.resolve()
  recordingHandle = await startRecording({
    source,
    microphone: settings.ok ? settings.data.captureMicrophone : false,
    onChunk: (bytes) => {
      queue = queue.then(() => window.samba.capture.appendVideo(bytes)).catch(() => undefined)
    }
  })
  appendQueue = (): Promise<unknown> => queue
  onStarted()
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  still: null,
  stillMode: null,
  recordingMode: null,
  elapsed: 0,
  toast: null,
  error: null,

  start: async (mode) => {
    set({ error: null })
    try {
      // 녹화 중에는 새 녹화만 막는다(이미지 캡처는 녹화와 겹쳐도 된다). 조용히 무시하면
      // "직접 지정을 눌러도 아무 일도 없다"가 되므로 이유를 보여 준다
      if (get().recordingMode && isVideoCaptureMode(mode)) {
        throw new Error(RECORDING_BUSY_KEY)
      }
      // 직접 지정(이미지·비디오)은 정지 이미지를 띄우고 드래그로 영역을 고른다
      if (mode === 'direct' || mode === 'videoDirect') {
        // 화면 소스는 웹뷰가 접히기 전에 받아 둔다(웹뷰 좌표가 필요하다)
        if (mode === 'videoDirect') {
          const source = await window.samba.capture.videoSource(mode)
          if (!source.ok) throw new Error(source.error)
          pendingVideoSource = source.data
        }
        const r = await window.samba.capture.still()
        if (!r.ok) throw new Error(r.error)
        setWebviewCollapsed(true)
        set({ still: r.data, stillMode: mode })
        return
      }
      if (!isVideoCaptureMode(mode)) {
        const r = await window.samba.capture.run(mode)
        if (!r.ok) throw new Error(r.error)
        return
      }
      // --- 비디오 · 전체 화면 ---
      const source = await window.samba.capture.videoSource(mode)
      if (!source.ok) throw new Error(source.error)
      await beginRecording(mode, source.data, () => {
        set({ recordingMode: mode, elapsed: 0 })
        elapsedTimer = window.setInterval(() => set((s) => ({ elapsed: s.elapsed + 1 })), 1000)
      })
    } catch (e: unknown) {
      set({ error: toMessage(e) })
    }
  },

  closeStill: () => {
    setWebviewCollapsed(false)
    pendingVideoSource = null
    set({ still: null, stillMode: null })
  },

  cropAndSave: async (a, b) => {
    const still = get().still
    if (!still) return
    // 오버레이는 먼저 닫아 웹뷰를 돌려준다 — 저장은 뒤에서 이어진다
    get().closeStill()
    try {
      const rect = normalizeDragRect(a, b)
      const settings = await window.samba.settings.get()
      const format = settings.ok ? settings.data.captureFormat : 'png'
      // 정지 이미지는 화면 배율만큼 크므로 드래그 좌표를 이미지 좌표로 옮긴다
      const scaled = {
        x: rect.x * still.scale,
        y: rect.y * still.scale,
        width: rect.width * still.scale,
        height: rect.height * still.scale
      }
      const dataUrl = await cropDataUrl(still.dataUrl, scaled, format)
      const saved = await window.samba.capture.saveImage(dataUrl)
      if (!saved.ok) throw new Error(saved.error)
    } catch (e: unknown) {
      set({ error: toMessage(e) })
    }
  },

  recordRegion: async (a, b) => {
    const source = pendingVideoSource
    if (!get().still || !source) return
    // 오버레이를 닫아 웹뷰를 돌려준 뒤 녹화를 시작한다(녹화 화면에 오버레이가 남지 않게)
    get().closeStill()
    try {
      if (!source.viewport) throw new Error('녹화할 영역을 찾지 못했습니다')
      // 웹뷰가 다시 그려질 틈을 준다 — 첫 프레임에 오버레이 잔상이 담기지 않게
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120))
      const crop = videoRegionCrop(normalizeDragRect(a, b), {
        viewport: source.viewport,
        crop: source.crop,
        scaleFactor: source.scaleFactor
      })
      // 너무 작게 끈 선택은 실수로 본다 — 조용히 취소한다
      if (!crop) return
      await beginRecording('videoDirect', { ...source, crop }, () => {
        set({ recordingMode: 'videoDirect', elapsed: 0 })
        elapsedTimer = window.setInterval(() => set((s) => ({ elapsed: s.elapsed + 1 })), 1000)
      })
    } catch (e: unknown) {
      set({ error: toMessage(e) })
    }
  },

  stopRecording: async () => {
    const mode = get().recordingMode
    const handle = recordingHandle
    recordingHandle = null
    if (elapsedTimer !== null) {
      window.clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    set({ recordingMode: null, elapsed: 0 })
    if (!handle || !mode) return
    try {
      await handle.stop()
      // 마지막 청크까지 파일에 들어간 뒤 닫는다
      await appendQueue()
      const ended = await window.samba.capture.endVideo(mode)
      if (!ended.ok) throw new Error(ended.error)
    } catch (e: unknown) {
      set({ error: toMessage(e) })
    }
  },

  showToast: (dto) => set({ toast: dto }),
  dismissToast: () => set({ toast: null }),
  clearError: () => set({ error: null })
}))

/** 경과 시간을 `m:ss` 로 */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
