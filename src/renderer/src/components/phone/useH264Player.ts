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

/** SPS 를 못 읽었을 때 쓰는 기본 코덱(baseline 3.0) */
const H264_FALLBACK_CODEC = 'avc1.42E01E'

/**
 * Annex-B 바이트에서 SPS(NAL 7)를 찾아 코덱 문자열(avc1.PPCCLL)을 만든다.
 * 폰마다 인코더가 내는 프로파일·레벨이 다르다(실기: SM A155N 은 baseline 3.0 으로 열면 디코더가 죽어
 * 간이 화면으로 내려갔다). 고정값으로 열지 않고 스트림이 말하는 값으로 연다
 */
export function codecFromAnnexB(data: Uint8Array): string | null {
  for (let i = 0; i + 7 < data.length; i += 1) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue
    const start = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1
    if (start < 0 || start + 3 >= data.length) continue
    if ((data[start] & 0x1f) !== 7) continue
    const hex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase()
    return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`
  }
  return null
}

/** Annex-B 바이트에 들어 있는 NAL 종류(nal_unit_type)를 순서대로 뽑는다 */
export function nalTypesOf(data: Uint8Array): number[] {
  const types: number[] = []
  for (let i = 0; i + 3 < data.length; i += 1) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue
    const start = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1
    if (start < 0 || start >= data.length) continue
    types.push(data[start] & 0x1f)
    i = start
  }
  return types
}

const NAL_IDR = 5
const NAL_SLICE = 1

/**
 * 디코더에 넣을 조각을 고른다.
 * screenrecord 는 SPS/PPS(설정)와 IDR(첫 화면)을 따로 보낼 때가 많다. 설정만 든 조각을 키프레임이라고
 * 넣으면 VideoDecoder 가 "A key frame is required" 로 죽는다(실기: 그래서 간이 화면으로 떨어지곤 했다).
 * 화면 데이터가 없는 조각은 모아 두었다가 다음 조각 앞에 붙이고, IDR 이 든 조각만 key 로 넘긴다
 */
export function nextDecodable(
  pending: Uint8Array | null,
  bytes: Uint8Array,
  started: boolean
): { pending: Uint8Array | null; chunk: { type: 'key' | 'delta'; data: Uint8Array } | null } {
  const types = nalTypesOf(bytes)
  const hasIdr = types.includes(NAL_IDR)
  const hasPicture = hasIdr || types.includes(NAL_SLICE)
  const joined = pending ? concatBytes(pending, bytes) : bytes
  // 화면 데이터가 없다(SPS·PPS·SEI 뿐) — 다음 조각에 붙인다
  if (!hasPicture) return { pending: joined, chunk: null }
  // 아직 첫 IDR 을 못 받았으면 그 전의 조각은 풀 수 없다
  if (!started && !hasIdr) return { pending, chunk: null }
  return { pending: null, chunk: { type: hasIdr ? 'key' : 'delta', data: joined } }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

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

    // 스트림이 말한 코덱으로 열었다가 디코더가 죽으면, 기본 코덱으로 한 번 더 열어 본다.
    // 그래도 안 되면 그때 간이 화면으로 내려간다(실기: 폰마다 통하는 쪽이 달랐다)
    let useFallbackCodec = false
    const onDecoderError = (): void => {
      if (disposed) return
      if (useFallbackCodec) return fallbackToStill()
      useFallbackCodec = true
      decoder = null
      sawKeyframeRef.current = false
      pendingConfig = null
      // 새 키프레임을 받으려면 세그먼트를 다시 열어야 한다
      void api.screenStop?.(serial).then(() => {
        if (!disposed) void api.screenStart?.(serial)
      })
    }

    const makeDecoder = (codec: string): VideoDecoderLike | null => {
      const Ctor = videoDecoderCtor()
      if (!Ctor) return null
      try {
        const d = new Ctor({
          output: (frame) => {
            draw(frame, frame.displayWidth, frame.displayHeight)
            frame.close()
            if (!disposed) setStatus('playing')
          },
          error: () => onDecoderError()
        })
        d.configure({ codec, optimizeForLatency: true })
        return d
      } catch {
        return null
      }
    }

    // 설정(SPS/PPS)만 든 조각을 모아 두는 곳 — 다음 IDR 앞에 붙인다
    let pendingConfig: Uint8Array | null = null
    // 스트림이 알려 준 코덱. 설정 조각에서 읽어 둔다(IDR 조각에는 SPS 가 없을 수 있다)
    let streamCodec: string | null = null

    const handleVideoChunk = (chunk: PhoneScreenChunk): void => {
      if (!chunk.data) return
      const bytes = new Uint8Array(chunk.data)
      streamCodec = codecFromAnnexB(bytes) ?? streamCodec
      const next = nextDecodable(pendingConfig, bytes, sawKeyframeRef.current)
      pendingConfig = next.pending
      if (!next.chunk) return
      if (next.chunk.type === 'key') sawKeyframeRef.current = true
      if (!decoder) {
        // 첫 키프레임에는 SPS 가 실려 온다 — 거기 적힌 프로파일·레벨로 디코더를 연다
        decoder = makeDecoder(
          useFallbackCodec ? H264_FALLBACK_CODEC : (streamCodec ?? H264_FALLBACK_CODEC)
        )
        if (!decoder) {
          fallbackToStill()
          return
        }
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: next.chunk.type,
            timestamp: performance.now() * 1000,
            data: next.chunk.data
          })
        )
      } catch {
        onDecoderError()
      }
    }

    const handleStillChunk = (chunk: PhoneScreenChunk): void => {
      // 메인은 PNG 바이트(data)를 보낸다. dataUrl 은 테스트·구형 경로 호환용
      const bytes = chunk.data
      if (!chunk.dataUrl && bytes) {
        // blob: URL 을 <img> 로 읽으면 앱의 CSP(img-src 'self' data:)에 막혀 영영 안 그려진다(실기).
        // ImageBitmap 은 이미지 요청이 아니라서 CSP 를 넓히지 않고도 그릴 수 있다
        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
        void createImageBitmap(blob)
          .then((bitmap) => {
            if (!disposed) {
              draw(bitmap, bitmap.width, bitmap.height)
              setStatus('playing')
            }
            bitmap.close()
          })
          .catch(() => {
            // 깨진 한 장은 건너뛴다 — 다음 장이 곧 온다
          })
        return
      }
      const url = chunk.dataUrl ?? null
      if (!url) return
      const img = new Image()
      img.onload = () => {
        if (!disposed) {
          draw(img, img.naturalWidth, img.naturalHeight)
          setStatus('playing')
        }
        if (!chunk.dataUrl) URL.revokeObjectURL(url)
      }
      img.onerror = () => {
        if (!chunk.dataUrl) URL.revokeObjectURL(url)
      }
      img.src = url
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
