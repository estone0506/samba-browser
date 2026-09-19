import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ScreenMode } from '@shared/phone'
import type { PhoneScreenChunk } from '@renderer/types/samba'
import { usePhoneStore } from '@renderer/stores/phoneStore'

// 폰 화면 재생 훅.
//   video : WebCodecs VideoDecoder 로 Annex-B h264 를 풀어 <canvas> 에 그린다
//   still : 주기 스크린샷 PNG(data URL)를 그대로 <canvas> 에 그린다
// Task 5(scrcpy 스트림)가 아직 안 붙은 빌드에서는 화면 API 자체가 없으므로
// 'unavailable' 을 돌려주고 화면 자리에 "준비 중" 안내를 띄운다

/** 기대하는 h264 프로파일 — scrcpy 기본값(baseline 3.0) */
const H264_CODEC = 'avc1.42E01E'

export type ScreenStatus = 'unavailable' | 'starting' | 'playing' | 'failed'

interface Options {
  serial: string
  /** 화면을 실제로 켤지. 카드가 접혀 있으면 false 로 두어 대역을 아낀다 */
  active: boolean
}

interface Result {
  status: ScreenStatus
  /** 지금 실제로 쓰고 있는 방식. 동영상이 안 되면 still 로 내려간다 */
  mode: ScreenMode | null
}

// WebCodecs 타입은 lib.dom 에 있으나 구형 타입 정의를 쓰는 환경도 있어 최소 형태만 좁혀 둔다
interface VideoDecoderLike {
  configure(config: { codec: string; optimizeForLatency?: boolean }): void
  decode(chunk: EncodedVideoChunk): void
  close(): void
  readonly state: string
}

type VideoDecoderCtor = new (init: {
  output: (frame: VideoFrame) => void
  error: (e: DOMException) => void
}) => VideoDecoderLike

function videoDecoderCtor(): VideoDecoderCtor | null {
  const ctor = (globalThis as { VideoDecoder?: VideoDecoderCtor }).VideoDecoder
  return typeof ctor === 'function' ? ctor : null
}

export function useH264Player(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  opts: Options
): Result {
  const { serial, active } = opts
  const [status, setStatus] = useState<ScreenStatus>('starting')
  const [mode, setMode] = useState<ScreenMode | null>(null)
  const setScreenMode = usePhoneStore((s) => s.setScreenMode)
  // 첫 키프레임을 받기 전 청크는 버린다(디코더가 깨진 프레임을 물면 복구가 안 된다)
  const sawKeyframeRef = useRef(false)
  // 청크 처리기 안에서 최신 모드를 보려면 상태가 아니라 ref 를 봐야 한다
  const modeRef = useRef<ScreenMode | null>(null)
  // Task 5 가 아직 안 붙은 빌드인지 — 렌더 중에 바로 판단할 수 있다
  const apiReady =
    typeof window.samba.phone.screenStart === 'function' &&
    typeof window.samba.phone.onScreenChunk === 'function'

  // 폰이나 펼침 상태가 바뀌면 렌더 중에 상태를 되돌린다.
  // 이펙트 안에서 setState 를 부르면 렌더가 한 번 더 도는 것을 피하기 위해서다
  const streamKey = `${serial}:${String(active)}`
  const [lastStreamKey, setLastStreamKey] = useState(streamKey)
  if (lastStreamKey !== streamKey) {
    setLastStreamKey(streamKey)
    setStatus('starting')
    setMode(null)
  }

  useEffect(() => {
    if (!active) return
    modeRef.current = null
    const api = window.samba.phone
    const start = api.screenStart
    const onChunk = api.onScreenChunk
    if (!start || !onChunk) return

    let disposed = false
    let decoder: VideoDecoderLike | null = null
    sawKeyframeRef.current = false

    const draw = (source: CanvasImageSource, w: number, h: number): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(source, 0, 0, w, h)
    }

    // 동영상이 안 되면 간이 화면으로 내려 달라고 메인에 요청한다
    const fallbackToStill = (): void => {
      if (disposed) return
      decoder = null
      sawKeyframeRef.current = false
      void api.screenStop?.(serial).then(() => {
        if (disposed) return
        void api.screenStart?.(serial, 'still')
      })
      modeRef.current = 'still'
      setMode('still')
      setScreenMode(serial, 'still')
    }

    const makeDecoder = (): VideoDecoderLike | null => {
      const Ctor = videoDecoderCtor()
      if (!Ctor) return null
      try {
        const d = new Ctor({
          output: (frame) => {
            draw(frame, frame.displayWidth, frame.displayHeight)
            frame.close()
            if (!disposed) setStatus('playing')
          },
          error: () => fallbackToStill()
        })
        d.configure({ codec: H264_CODEC, optimizeForLatency: true })
        return d
      } catch {
        return null
      }
    }

    const handleVideoChunk = (chunk: PhoneScreenChunk): void => {
      if (!chunk.data) return
      if (!decoder) {
        decoder = makeDecoder()
        if (!decoder) {
          fallbackToStill()
          return
        }
      }
      if (!sawKeyframeRef.current) {
        if (!chunk.keyframe) return
        sawKeyframeRef.current = true
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: chunk.keyframe ? 'key' : 'delta',
            timestamp: performance.now() * 1000,
            data: chunk.data
          })
        )
      } catch {
        fallbackToStill()
      }
    }

    const handleStillChunk = (chunk: PhoneScreenChunk): void => {
      if (!chunk.dataUrl) return
      const img = new Image()
      img.onload = () => {
        if (disposed) return
        draw(img, img.naturalWidth, img.naturalHeight)
        setStatus('playing')
      }
      img.src = chunk.dataUrl
    }

    const off = onChunk((chunk) => {
      if (disposed || chunk.serial !== serial) return
      if (chunk.mode !== modeRef.current) {
        modeRef.current = chunk.mode
        setMode(chunk.mode)
        setScreenMode(serial, chunk.mode)
      }
      if (chunk.mode === 'video') handleVideoChunk(chunk)
      else handleStillChunk(chunk)
    })

    void start(serial).then((r) => {
      if (disposed) return
      if (!r.ok) {
        setStatus('failed')
        return
      }
      modeRef.current = r.data
      setMode(r.data)
      setScreenMode(serial, r.data)
    })

    return () => {
      disposed = true
      off()
      if (decoder && decoder.state !== 'closed') {
        try {
          decoder.close()
        } catch {
          // 이미 닫힌 디코더 — 무시한다
        }
      }
      void api.screenStop?.(serial)
      setScreenMode(serial, null)
    }
  }, [serial, active, canvasRef, setScreenMode])

  return { status: apiReady ? status : 'unavailable', mode }
}
