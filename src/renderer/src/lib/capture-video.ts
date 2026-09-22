// 화면 녹화(webm · vp9). desktopCapturer 소스 id 는 메인이 주고, 실제 녹화는
// 렌더러의 MediaRecorder 가 한다. '직접 지정' 은 화면 소스를 canvas 로 잘라서 녹화한다

import type { CaptureVideoSourceDto } from '@shared/capture'
import i18n from '@renderer/i18n'

// vp9 우선, 안 되면 브라우저가 고르게 둔다
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export function pickRecorderMime(isSupported: (mime: string) => boolean): string {
  return MIME_CANDIDATES.find((m) => isSupported(m)) ?? ''
}

export interface RecordingHandle {
  /** 녹화를 멈추고 webm 바이트를 돌려준다 */
  stop: () => Promise<Uint8Array>
}

interface DesktopConstraint {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId: string
    maxWidth: number
    maxHeight: number
    maxFrameRate: number
  }
}

/** Electron 의 desktopCapturer 소스를 가져오는 비표준 제약(타입 단언으로만 표현된다) */
function desktopConstraints(source: CaptureVideoSourceDto, fps: number): MediaStreamConstraints {
  const video: DesktopConstraint = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.sourceId,
      maxWidth: source.width,
      maxHeight: source.height,
      maxFrameRate: fps
    }
  }
  return { audio: false, video } as unknown as MediaStreamConstraints
}

async function videoElementFrom(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  await video.play()
  // 첫 프레임이 들어와야 videoWidth 가 채워진다
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = (): void => resolve()
      window.setTimeout(resolve, 1000)
    })
  }
  return video
}

export interface StartRecordingOptions {
  source: CaptureVideoSourceDto
  /** 마이크 소리를 함께 담을지 */
  microphone: boolean
  fps?: number
  /** 청크가 생길 때마다(약 1초) 호출된다 — 바로 파일에 이어 쓰는 용도 */
  onChunk?: (bytes: Uint8Array) => void
}

/**
 * 녹화를 시작한다. crop 이 있으면 canvas 로 그 영역만 잘라 녹화하고,
 * 없으면 화면 스트림을 그대로 녹화한다
 */
export async function startRecording(options: StartRecordingOptions): Promise<RecordingHandle> {
  const fps = options.fps ?? 30
  const screenStream = await navigator.mediaDevices.getUserMedia(
    desktopConstraints(options.source, fps)
  )

  const cleanups: Array<() => void> = [() => screenStream.getTracks().forEach((t) => t.stop())]

  let recordedStream = screenStream
  if (options.source.crop) {
    const crop = options.source.crop
    const video = await videoElementFrom(screenStream)
    // 실제 트랙 크기가 메인이 알려 준 크기와 다르면 그 비율만큼 크롭도 옮긴다
    const ratio = video.videoWidth > 0 ? video.videoWidth / Math.max(1, options.source.width) : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(crop.width * ratio))
    canvas.height = Math.max(2, Math.round(crop.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(i18n.t('screenCapture.canvasFailed'))
    const draw = (): void => {
      ctx.drawImage(
        video,
        Math.round(crop.x * ratio),
        Math.round(crop.y * ratio),
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      )
    }
    // requestAnimationFrame 은 창이 가려지면 멈춰 캔버스가 빈 채로 녹화된다(0바이트 파일).
    // 타이머로 돌려 창이 보이든 말든 같은 속도로 프레임을 채운다
    draw()
    const timer = window.setInterval(draw, Math.max(1, Math.round(1000 / fps)))
    cleanups.push(() => window.clearInterval(timer))
    cleanups.push(() => video.remove())
    recordedStream = canvas.captureStream(fps)
    cleanups.push(() => recordedStream.getTracks().forEach((t) => t.stop()))
  }

  if (options.microphone) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of mic.getAudioTracks()) recordedStream.addTrack(track)
      cleanups.push(() => mic.getTracks().forEach((t) => t.stop()))
    } catch (e: unknown) {
      // 마이크를 못 잡아도 화면 녹화는 계속한다
      console.warn('마이크를 사용할 수 없어요', e instanceof Error ? e.message : String(e))
    }
  }

  const mimeType = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m))
  const recorder = new MediaRecorder(recordedStream, mimeType ? { mimeType } : undefined)
  const onChunk = options.onChunk
  // onChunk 가 있으면 청크는 곧바로 파일로 흘러가므로 메모리에 또 쌓지 않는다.
  // (둘 다 들고 있으면 긴 녹화에서 영상 크기의 두 배가 렌더러 메모리에 남았다)
  const chunks: Blob[] | null = onChunk ? null : []
  // 마지막 청크는 stop() 바로 앞에 dataavailable 로 온다. Blob→ArrayBuffer 변환이
  // 비동기라 그대로 두면 onstop 이 먼저 끝나고, 호출부가 파일을 닫아 마지막 조각이 사라진다.
  // 변환을 한 줄로 이어 두고 stop() 이 이 줄을 기다리게 한다(순서도 함께 지켜진다)
  let pendingChunks: Promise<unknown> = Promise.resolve()
  recorder.ondataavailable = (e): void => {
    if (e.data.size <= 0) return
    if (!onChunk) {
      chunks?.push(e.data)
      return
    }
    pendingChunks = pendingChunks
      .then(() => e.data.arrayBuffer())
      .then((buf) => onChunk(new Uint8Array(buf)))
      .catch(() => undefined)
  }
  // onerror 는 stop() 을 기다리지 않고 지금 걸어 둔다 — 녹화 도중에 난 오류를
  // 아무도 듣지 않으면 스트림·타이머가 그대로 돌고 사용자도 알 수 없다
  let recorderError: Error | null = null
  let onRecorderError: ((e: Error) => void) | null = null
  recorder.onerror = (): void => {
    recorderError = new Error(i18n.t('screenCapture.recorderError'))
    for (const fn of cleanups) fn()
    onRecorderError?.(recorderError)
  }
  recorder.start(1000)

  return {
    stop: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        // 이미 오류로 끝났으면 바로 알린다(정리는 onerror 에서 끝났다)
        if (recorderError) {
          reject(recorderError)
          return
        }
        onRecorderError = reject
        recorder.onstop = (): void => {
          for (const fn of cleanups) fn()
          // 마지막 청크 쓰기가 끝난 뒤에야 끝났다고 알린다
          void pendingChunks
            .then(() =>
              chunks
                ? new Blob(chunks, { type: mimeType || 'video/webm' }).arrayBuffer()
                : new ArrayBuffer(0)
            )
            .then((buffer) => resolve(new Uint8Array(buffer)))
            .catch(reject)
        }
        if (recorder.state === 'inactive') recorder.onstop?.(new Event('stop'))
        else recorder.stop()
      })
  }
}

/** 정지 이미지에서 사각 영역만 잘라 data URL 로 만든다(직접 지정) */
export async function cropDataUrl(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  format: 'png' | 'jpg'
): Promise<string> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width))
  canvas.height = Math.max(1, Math.round(rect.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(i18n.t('screenCapture.canvasFailed'))
  ctx.drawImage(
    image,
    Math.round(rect.x),
    Math.round(rect.y),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  return canvas.toDataURL(format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92)
}
