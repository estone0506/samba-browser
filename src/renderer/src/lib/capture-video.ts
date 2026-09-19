// 화면 녹화(webm · vp9). desktopCapturer 소스 id 는 메인이 주고, 실제 녹화는
// 렌더러의 MediaRecorder 가 한다. '직접 지정' 은 화면 소스를 canvas 로 잘라서 녹화한다

import type { CaptureVideoSourceDto } from '@shared/capture'

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
    if (!ctx) throw new Error('캔버스를 만들지 못했습니다')
    let frame = 0
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
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    cleanups.push(() => cancelAnimationFrame(frame))
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
  const chunks: Blob[] = []
  recorder.ondataavailable = (e): void => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start(1000)

  return {
    stop: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        recorder.onerror = (): void => {
          for (const fn of cleanups) fn()
          reject(new Error('녹화 중 오류가 났어요'))
        }
        recorder.onstop = (): void => {
          for (const fn of cleanups) fn()
          void new Blob(chunks, { type: mimeType || 'video/webm' })
            .arrayBuffer()
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
  if (!ctx) throw new Error('캔버스를 만들지 못했습니다')
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
