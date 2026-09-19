// 폰 화면 스트림 테스트. 가짜 adb·가짜 타이머만 쓰고 adb·scrcpy 를 한 번도 실행하지 않는다

import { describe, it, expect, beforeEach } from 'vitest'
import { FakeAdb } from './stubs/fake-adb'
import {
  ScreenStream,
  parseWmSize,
  screenSizeArg,
  KEYFRAME_TIMEOUT_MS,
  RECORD_SEGMENT_MS,
  STILL_INTERVAL_MS,
  type ScreenChunk,
  type ScreenStreamDeps
} from '../src/main/phone/screen'
import type { ScreenMode } from '../src/shared/phone'

const SERIAL = 'R3CRA05HY3R'
const WM_SIZE = 'Physical size: 1080x2400\n'

/** 손으로 만든 NAL(4바이트 시작 코드) */
function nal(type: number, ...rest: number[]): Buffer {
  return Buffer.from([0, 0, 0, 1, type & 0x1f, ...rest])
}

/** 다음 NAL 이 잘리지 않도록 뒤에 더미 NAL 을 붙여 온전한 조각만 나가게 한다 */
function keyframeChunk(): Buffer {
  return Buffer.concat([nal(7, 0x11), nal(8, 0x22), nal(5, 0x33), nal(1, 0x44)])
}

function deltaChunk(): Buffer {
  return Buffer.concat([nal(1, 0x55), nal(1, 0x66)])
}

/** 가짜 시계 + 가짜 타이머 */
class FakeClock {
  private ms = 0
  private seq = 0
  private jobs = new Map<number, { at: number; fn: () => void }>()

  now = (): number => this.ms

  setTimeout = (fn: () => void, delay: number): unknown => {
    const id = ++this.seq
    this.jobs.set(id, { at: this.ms + delay, fn })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.jobs.delete(handle)
  }

  /** 남아 있는 타이머 수 */
  get pending(): number {
    return this.jobs.size
  }

  /** 시간을 흘려보내고 그 사이 도래한 타이머를 모두 실행한다(비동기 작업도 흘린다) */
  async advance(ms: number): Promise<void> {
    const target = this.ms + ms
    for (;;) {
      const due = [...this.jobs.entries()]
        .filter(([, j]) => j.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, job] = due
      this.jobs.delete(id)
      this.ms = job.at
      job.fn()
      await flush()
    }
    this.ms = target
    await flush()
  }
}

/** 마이크로태스크·setImmediate 대기 열을 비운다 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface Harness {
  adb: FakeAdb
  clock: FakeClock
  chunks: ScreenChunk[]
  modes: { serial: string; mode: ScreenMode }[]
  stream: ScreenStream
}

function makeHarness(over: Partial<ScreenStreamDeps> & { adb?: FakeAdb } = {}): Harness {
  const adb = over.adb ?? new FakeAdb()
  if (!over.adb) adb.reply('wm size', WM_SIZE)
  const clock = new FakeClock()
  const chunks: ScreenChunk[] = []
  const modes: { serial: string; mode: ScreenMode }[] = []
  const stream = new ScreenStream({
    size: () => 720,
    fps: () => 15,
    onChunk: (c) => chunks.push(c),
    onModeChange: (serial, mode) => modes.push({ serial, mode }),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...over,
    adb
  })
  return { adb, clock, chunks, modes, stream }
}

describe('parseWmSize', () => {
  it('Physical size 를 읽는다', () => {
    expect(parseWmSize(WM_SIZE)).toEqual({ width: 1080, height: 2400 })
  })

  it('Override size 가 있으면 그쪽을 쓴다', () => {
    const out = 'Physical size: 1440x3200\nOverride size: 1080x2400\n'
    expect(parseWmSize(out)).toEqual({ width: 1080, height: 2400 })
  })

  it('알아볼 수 없으면 null', () => {
    expect(parseWmSize('')).toBeNull()
    expect(parseWmSize('error: device offline')).toBeNull()
  })
})

describe('screenSizeArg', () => {
  it('짧은 변을 요청 해상도에 맞추고 비율을 지킨다', () => {
    expect(screenSizeArg({ width: 1080, height: 2400 }, 720)).toBe('720x1600')
  })

  it('가로 화면도 같은 비율로 줄인다', () => {
    expect(screenSizeArg({ width: 2400, height: 1080 }, 720)).toBe('1600x720')
  })

  it('폰이 요청보다 작으면 --size 를 생략한다(확대하지 않는다)', () => {
    expect(screenSizeArg({ width: 1080, height: 2400 }, 1080)).toBeNull()
    expect(screenSizeArg({ width: 720, height: 1280 }, 1080)).toBeNull()
  })
})

describe('ScreenStream', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('start 가 screenrecord 스트림을 연다', async () => {
    h.stream.start(SERIAL)
    await flush()
    const args = h.adb.streamArgs[0].join(' ')
    expect(args).toBe(
      `-s ${SERIAL} exec-out screenrecord --output-format=h264 --size 720x1600 --bit-rate 2000000 --time-limit 170 -`
    )
    h.stream.stopAll()
  })

  it('wm size 조회에 실패하면 --size 를 생략한다', async () => {
    const adb = new FakeAdb()
    adb.reply('wm size', 'error: closed')
    const h2 = makeHarness({ adb })
    h2.stream.start(SERIAL)
    await flush()
    expect(h2.adb.streamArgs[0].join(' ')).toBe(
      `-s ${SERIAL} exec-out screenrecord --output-format=h264 --bit-rate 2000000 --time-limit 170 -`
    )
    h2.stream.stopAll()
  })

  it('키프레임이 든 청크가 오면 video 모드로 청크를 내보낸다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(keyframeChunk())
    expect(h.modes).toEqual([{ serial: SERIAL, mode: 'video' }])
    expect(h.chunks).toHaveLength(1)
    expect(h.chunks[0].mode).toBe('video')
    expect(h.chunks[0].keyframe).toBe(true)
    expect(h.chunks[0].serial).toBe(SERIAL)
    // 시작 코드를 붙여 그대로 디코드 가능한 바이트로 나간다
    expect(h.chunks[0].data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]))
    h.stream.stopAll()
  })

  it('키프레임 전 조각은 버리고 키프레임 뒤부터 내보낸다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(deltaChunk())
    expect(h.chunks).toHaveLength(0)
    h.adb.push(keyframeChunk())
    h.adb.push(deltaChunk())
    expect(h.chunks).toHaveLength(2)
    expect(h.chunks[1].keyframe).toBe(false)
    h.stream.stopAll()
  })

  it('5초 안에 키프레임이 없으면 간이 화면으로 내려간다', async () => {
    h.adb.replyBinary('screencap -p', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    h.stream.start(SERIAL)
    await flush()
    expect(h.adb.liveStreams).toBe(1)
    await h.clock.advance(KEYFRAME_TIMEOUT_MS)
    expect(h.modes).toEqual([{ serial: SERIAL, mode: 'still' }])
    // 동영상 스트림은 닫히고 screencap 으로 갈아탄다
    expect(h.adb.liveStreams).toBe(0)
    expect(h.chunks).toHaveLength(1)
    expect(h.chunks[0].mode).toBe('still')
    expect(h.chunks[0].keyframe).toBe(true)
    await h.clock.advance(STILL_INTERVAL_MS)
    expect(h.chunks).toHaveLength(2)
    expect(h.adb.calls.some((c) => c.join(' ').includes('exec-out screencap -p'))).toBe(true)
    h.stream.stopAll()
  })

  it('간이 화면에서 빈 버퍼가 오면 그 프레임만 건너뛴다', async () => {
    h.stream.start(SERIAL)
    await flush()
    await h.clock.advance(KEYFRAME_TIMEOUT_MS)
    expect(h.modes).toEqual([{ serial: SERIAL, mode: 'still' }])
    expect(h.chunks).toHaveLength(0)
    // 다음 주기에 정상 프레임이 오면 다시 나간다(스트림은 멈추지 않았다)
    h.adb.replyBinary('screencap -p', Buffer.from([0x89, 0x50]))
    await h.clock.advance(STILL_INTERVAL_MS)
    expect(h.chunks).toHaveLength(1)
    h.stream.stopAll()
  })

  it('세션 상한으로 스트림이 죽으면 다시 연다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(keyframeChunk())
    expect(h.adb.streamArgs).toHaveLength(1)
    await h.clock.advance(1000)
    h.adb.endStream(0)
    await flush()
    expect(h.adb.streamArgs).toHaveLength(2)
    expect(h.modes).toEqual([{ serial: SERIAL, mode: 'video' }])
    h.stream.stopAll()
  })

  it('세그먼트 시간이 차면 스스로 다시 연다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(keyframeChunk())
    await h.clock.advance(RECORD_SEGMENT_MS)
    expect(h.adb.streamArgs).toHaveLength(2)
    expect(h.adb.liveStreams).toBe(1)
    h.stream.stopAll()
  })

  it('키프레임 없이 연달아 죽으면 간이 화면으로 내려간다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.endStream(1)
    await flush()
    expect(h.modes).toEqual([{ serial: SERIAL, mode: 'still' }])
  })

  it('stop 뒤에는 청크도 타이머도 남지 않는다', async () => {
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(keyframeChunk())
    expect(h.chunks).toHaveLength(1)
    h.stream.stop(SERIAL)
    expect(h.adb.liveStreams).toBe(0)
    expect(h.clock.pending).toBe(0)
    h.adb.push(keyframeChunk())
    await h.clock.advance(RECORD_SEGMENT_MS * 2)
    expect(h.chunks).toHaveLength(1)
    expect(h.adb.streamArgs).toHaveLength(1)
  })

  it('간이 화면 모드에서 stop 하면 타이머가 남지 않는다', async () => {
    h.adb.replyBinary('screencap -p', Buffer.from([1, 2]))
    h.stream.start(SERIAL)
    await flush()
    await h.clock.advance(KEYFRAME_TIMEOUT_MS)
    const seen = h.chunks.length
    h.stream.stop(SERIAL)
    expect(h.clock.pending).toBe(0)
    await h.clock.advance(STILL_INTERVAL_MS * 5)
    expect(h.chunks).toHaveLength(seen)
  })

  it('같은 폰을 두 번 start 해도 스트림은 하나다', async () => {
    h.stream.start(SERIAL)
    h.stream.start(SERIAL)
    await flush()
    expect(h.adb.streamArgs).toHaveLength(1)
    h.stream.stopAll()
  })

  it('비밀 화면 훅이 참이면 프레임을 내보내지 않는다', async () => {
    let secret = true
    const h2 = makeHarness({ isSecretScreen: () => secret })
    h2.stream.start(SERIAL)
    await flush()
    h2.adb.push(keyframeChunk())
    expect(h2.chunks).toHaveLength(0)
    // 모드 통지는 그대로 간다(화면 자리는 비워 둔 채 안내한다)
    expect(h2.modes).toEqual([{ serial: SERIAL, mode: 'video' }])
    secret = false
    h2.adb.push(deltaChunk())
    expect(h2.chunks).toHaveLength(1)
    h2.stream.stopAll()
  })

  it('mode 로 지금 전송 방식을 알 수 있고 stop 하면 null 이다', async () => {
    expect(h.stream.mode(SERIAL)).toBeNull()
    h.stream.start(SERIAL)
    await flush()
    h.adb.push(keyframeChunk())
    expect(h.stream.mode(SERIAL)).toBe('video')
    h.stream.stop(SERIAL)
    expect(h.stream.mode(SERIAL)).toBeNull()
  })
})
