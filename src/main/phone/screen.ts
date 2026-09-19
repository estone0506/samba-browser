// 폰 화면 전송. 두 가지 방식을 자동으로 오간다.
//   (b) 동영상: `adb exec-out screenrecord --output-format=h264 -` 의 raw Annex-B 를
//       그대로 파이프해 렌더러 WebCodecs 가 디코드한다. screenrecord 는 한 세션이
//       180초에서 끊기므로 170초마다 스스로 다시 연다
//   (c) 간이 화면: 동영상이 안 되면 1초 주기 `exec-out screencap -p` 로 내려간다
// 프로세스 실행은 AdbRunner 인터페이스 뒤에만 있어 테스트는 가짜 adb 만 쓴다

import type { ScreenFps, ScreenMode, ScreenSize } from '../../shared/phone'
import type { AdbRunner } from './process'
import { execOutArgs, shellArgs } from './adb'
import { AnnexBAssembler, hasKeyframe, toAnnexB } from './h264'

/** 첫 키프레임을 이 시간 안에 못 받으면 간이 화면으로 내려간다 */
export const KEYFRAME_TIMEOUT_MS = 5000
/** screenrecord 한 세션 길이(안드로이드 상한 180초보다 짧게) */
export const RECORD_SEGMENT_MS = 170_000
/** 간이 화면 캡처 주기 */
export const STILL_INTERVAL_MS = 1000
/** screenrecord 에 넘길 --time-limit(초). RECORD_SEGMENT_MS 와 같은 길이다 */
export const RECORD_TIME_LIMIT_S = RECORD_SEGMENT_MS / 1000
/** 동영상 비트레이트(2Mbps) */
export const VIDEO_BIT_RATE = 2_000_000
/** 이 시간 안에 끝난 세그먼트는 "곧바로 죽었다" 로 본다 */
const FAST_RESTART_MS = 1000
/** 곧바로 죽는 일이 이만큼 이어지면 간이 화면으로 내려간다(재시작 폭주 방지) */
const MAX_FAST_RESTARTS = 3
/** screencap 한 장 제한 시간 */
const STILL_TIMEOUT_MS = 5000

export interface ScreenChunk {
  serial: string
  mode: ScreenMode
  data: Buffer
  keyframe: boolean
}

export interface PhysicalSize {
  width: number
  height: number
}

export interface ScreenStreamDeps {
  adb: AdbRunner
  size: () => ScreenSize
  fps: () => ScreenFps
  onChunk: (c: ScreenChunk) => void
  onModeChange: (serial: string, mode: ScreenMode) => void
  now: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /**
   * 비밀번호 입력 화면인가(T10 이 채운다). 참이면 그 프레임은 저장도 전송도 하지 않는다.
   * 지금은 훅 자리만 두고 기본값은 "아니다"
   */
  isSecretScreen?: (serial: string) => boolean
}

/** `wm size` 출력에서 실제 해상도를 읽는다. Override 가 있으면 그쪽이 지금 화면이다 */
export function parseWmSize(stdout: string): PhysicalSize | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
  const m = override ?? physical
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!width || !height) return null
  return { width, height }
}

/** 짝수로 맞춘다(인코더가 홀수 해상도를 싫어한다) */
function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}

/**
 * screenrecord `--size` 인자. 폰 실제 비율을 지킨 채 짧은 변을 요청 해상도에 맞춘다.
 * 폰이 요청보다 작으면 확대하지 않고 null(= --size 생략, 기기 기본값)을 돌려준다
 */
export function screenSizeArg(phys: PhysicalSize | null, size: ScreenSize): string | null {
  if (!phys) return null
  const shortSide = Math.min(phys.width, phys.height)
  if (shortSide <= size) return null
  const scale = size / shortSide
  return `${even(phys.width * scale)}x${even(phys.height * scale)}`
}

interface Session {
  serial: string
  stopped: boolean
  // 세그먼트 세대. 재시작·모드 전환 때마다 올려서 옛 콜백을 버린다
  gen: number
  mode: ScreenMode | null
  cancel: (() => void) | null
  timers: Set<unknown>
  assembler: AnnexBAssembler
  gotKeyframe: boolean
  segmentStartedAt: number
  fastRestarts: number
  // `wm size` 조회 결과로 만든 --size 값(조회 실패면 null). 폰당 한 번만 조회한다
  sizeArg: string | null
  sizeResolved: boolean
}

export class ScreenStream {
  private sessions = new Map<string, Session>()

  constructor(private deps: ScreenStreamDeps) {}

  /** 지금 이 폰의 전송 방식(안 보내고 있으면 null) */
  mode(serial: string): ScreenMode | null {
    return this.sessions.get(serial)?.mode ?? null
  }

  start(serial: string): void {
    if (this.sessions.has(serial)) return
    const s: Session = {
      serial,
      stopped: false,
      gen: 0,
      mode: null,
      cancel: null,
      timers: new Set(),
      assembler: new AnnexBAssembler(),
      gotKeyframe: false,
      segmentStartedAt: this.deps.now(),
      fastRestarts: 0,
      sizeArg: null,
      sizeResolved: false
    }
    this.sessions.set(serial, s)
    void this.openVideo(s)
  }

  stop(serial: string): void {
    const s = this.sessions.get(serial)
    if (!s) return
    s.stopped = true
    s.gen += 1
    s.mode = null
    this.closeSegment(s)
    this.sessions.delete(serial)
  }

  stopAll(): void {
    for (const serial of [...this.sessions.keys()]) this.stop(serial)
  }

  // --- 내부 -----------------------------------------------------------------

  private later(s: Session, fn: () => void, ms: number): void {
    const set = this.deps.setTimeout ?? ((f, d) => setTimeout(f, d))
    let handle: unknown = null
    handle = set(() => {
      s.timers.delete(handle)
      fn()
    }, ms)
    s.timers.add(handle)
  }

  /**
   * 이 세션의 타이머와 살아 있는 프로세스를 모두 정리한다.
   * 세대를 먼저 올려서 프로세스를 죽일 때 오는 종료 콜백이 재시작을 부르지 않게 한다
   */
  private closeSegment(s: Session): void {
    s.gen += 1
    const clear = this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
    for (const t of s.timers) clear(t)
    s.timers.clear()
    const cancel = s.cancel
    s.cancel = null
    cancel?.()
  }

  private setMode(s: Session, mode: ScreenMode): void {
    if (s.mode === mode) return
    s.mode = mode
    this.deps.onModeChange(s.serial, mode)
  }

  private emit(s: Session, mode: ScreenMode, data: Buffer, keyframe: boolean): void {
    // 비밀번호 입력 화면은 저장도 전송도 하지 않는다
    if (this.deps.isSecretScreen?.(s.serial)) return
    this.deps.onChunk({ serial: s.serial, mode, data, keyframe })
  }

  private async resolveSize(s: Session): Promise<void> {
    if (s.sizeResolved) return
    s.sizeResolved = true
    try {
      const res = await this.deps.adb.run(shellArgs(s.serial, 'wm size'))
      s.sizeArg = screenSizeArg(parseWmSize(res.stdout), this.deps.size())
    } catch {
      // 조회에 실패하면 --size 를 생략해 기기 기본값으로 둔다
      s.sizeArg = null
    }
  }

  private async openVideo(s: Session): Promise<void> {
    await this.resolveSize(s)
    if (s.stopped) return
    const gen = (s.gen += 1)
    s.assembler.reset()
    s.gotKeyframe = false
    s.segmentStartedAt = this.deps.now()

    const args = execOutArgs(s.serial, [
      'screenrecord',
      '--output-format=h264',
      ...(s.sizeArg ? ['--size', s.sizeArg] : []),
      '--bit-rate',
      String(VIDEO_BIT_RATE),
      '--time-limit',
      String(RECORD_TIME_LIMIT_S),
      '-'
    ])

    try {
      s.cancel = this.deps.adb.stream(
        args,
        (chunk) => this.onData(s, gen, chunk),
        (code) => this.onEnd(s, gen, code)
      )
    } catch {
      // adb 경로가 없는 등 스트림을 열지 못하면 간이 화면으로 내려간다
      this.fallbackToStill(s)
      return
    }

    this.later(
      s,
      () => {
        if (s.stopped || s.gen !== gen || s.gotKeyframe) return
        this.fallbackToStill(s)
      },
      KEYFRAME_TIMEOUT_MS
    )
    // 세션 상한에 걸려 끊기기 전에 우리가 먼저 다음 세그먼트를 연다
    this.later(
      s,
      () => {
        if (s.stopped || s.gen !== gen) return
        this.restartVideo(s)
      },
      RECORD_SEGMENT_MS
    )
  }

  private onData(s: Session, gen: number, chunk: Buffer): void {
    if (s.stopped || s.gen !== gen) return
    const nals = s.assembler.push(chunk)
    if (nals.length === 0) return
    const keyframe = hasKeyframe(nals)
    if (!s.gotKeyframe) {
      // 디코더는 SPS/IDR 부터 시작해야 한다. 그 전 조각은 버린다
      if (!keyframe) return
      s.gotKeyframe = true
      s.fastRestarts = 0
      this.setMode(s, 'video')
    }
    this.emit(s, 'video', toAnnexB(nals), keyframe)
  }

  private onEnd(s: Session, gen: number, _code: number | null): void {
    if (s.stopped || s.gen !== gen) return
    s.cancel = null
    const quick = this.deps.now() - s.segmentStartedAt < FAST_RESTART_MS
    if (!s.gotKeyframe && quick) s.fastRestarts += 1
    else s.fastRestarts = 0
    // 한 번도 화면을 못 받았거나 연달아 곧바로 죽으면 간이 화면이 낫다
    if (!s.gotKeyframe || s.fastRestarts >= MAX_FAST_RESTARTS) {
      this.fallbackToStill(s)
      return
    }
    this.restartVideo(s)
  }

  private restartVideo(s: Session): void {
    if (s.stopped) return
    this.closeSegment(s)
    if (s.stopped) return
    void this.openVideo(s)
  }

  private fallbackToStill(s: Session): void {
    if (s.stopped) return
    this.closeSegment(s)
    if (s.stopped) return
    const gen = s.gen
    this.setMode(s, 'still')
    void this.captureStill(s, gen)
  }

  private async captureStill(s: Session, gen: number): Promise<void> {
    if (s.stopped || s.gen !== gen) return
    let png: Buffer | null = null
    try {
      png = await this.deps.adb.runBinary(
        execOutArgs(s.serial, ['screencap', '-p']),
        STILL_TIMEOUT_MS
      )
    } catch {
      // 한 장 실패는 건너뛴다(스트림은 계속 돈다)
      png = null
    }
    if (s.stopped || s.gen !== gen) return
    if (png && png.length > 0) this.emit(s, 'still', png, true)
    this.later(
      s,
      () => {
        if (s.stopped || s.gen !== gen) return
        void this.captureStill(s, gen)
      },
      STILL_INTERVAL_MS
    )
  }
}
