import { create } from 'zustand'
import {
  isVideoCaptureMode,
  normalizeDragRect,
  type CaptureMode,
  type CaptureResultDto,
  type CaptureStillDto
} from '@shared/capture'
import { cropDataUrl, startRecording, type RecordingHandle } from '@renderer/lib/capture-video'
import { useUiStore } from './uiStore'

// 녹화 중인 작업. 핸들은 스토어 상태에 넣지 않는다(리렌더 대상이 아니다)
let recordingHandle: RecordingHandle | null = null
let elapsedTimer: number | null = null

export interface CaptureState {
  /** 직접 지정 오버레이에 띄운 정지 이미지. null 이면 오버레이가 닫혀 있다 */
  still: CaptureStillDto | null
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

export const useCaptureStore = create<CaptureState>((set, get) => ({
  still: null,
  recordingMode: null,
  elapsed: 0,
  toast: null,
  error: null,

  start: async (mode) => {
    set({ error: null })
    try {
      // 녹화 중에 다른 캡처를 시작하지 않는다(먼저 중지해야 한다)
      if (get().recordingMode) return
      if (mode === 'direct') {
        const r = await window.samba.capture.still()
        if (!r.ok) throw new Error(r.error)
        setWebviewCollapsed(true)
        set({ still: r.data })
        return
      }
      if (!isVideoCaptureMode(mode)) {
        const r = await window.samba.capture.run(mode)
        if (!r.ok) throw new Error(r.error)
        return
      }
      // --- 비디오 ---
      const source = await window.samba.capture.videoSource(mode)
      if (!source.ok) throw new Error(source.error)
      const settings = await window.samba.settings.get()
      recordingHandle = await startRecording({
        source: source.data,
        microphone: settings.ok ? settings.data.captureMicrophone : false
      })
      set({ recordingMode: mode, elapsed: 0 })
      elapsedTimer = window.setInterval(() => set((s) => ({ elapsed: s.elapsed + 1 })), 1000)
    } catch (e: unknown) {
      set({ error: toMessage(e) })
    }
  },

  closeStill: () => {
    setWebviewCollapsed(false)
    set({ still: null })
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
      const bytes = await handle.stop()
      const saved = await window.samba.capture.saveVideo(bytes, mode)
      if (!saved.ok) throw new Error(saved.error)
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
