// 폰 화면 IPC 배선 테스트. 가짜 adb·가짜 scrcpy 만 넣어 실제 프로세스를 띄우지 않는다

import { describe, it, expect } from 'vitest'
import { FakeAdb } from './stubs/fake-adb'
import { registerPhoneScreenIpc } from '../src/main/phone/screen-ipc'
import { ScrcpyWindows } from '../src/main/phone/scrcpy'
import { IPC } from '../src/shared/ipc'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const SERIAL = 'R3CRA05HY3R'

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface Setup {
  adb: FakeAdb
  handlers: Map<string, (...args: never[]) => unknown>
  sent: { channel: string; payload: unknown }[]
  spawned: string[][]
  ipc: ReturnType<typeof registerPhoneScreenIpc>
  call: (channel: string, arg: string) => unknown
}

function setup(over: Partial<Settings> = {}): Setup {
  const adb = new FakeAdb()
  adb.reply('wm size', 'Physical size: 1080x2400\n')
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const sent: { channel: string; payload: unknown }[] = []
  const spawned: string[][] = []
  const scrcpy = new ScrcpyWindows({
    spawn: (args) => {
      spawned.push(args)
      return () => {}
    },
    path: () => 'C:\\pt\\scrcpy.exe',
    size: () => 720,
    fps: () => 15
  })
  const ipc = registerPhoneScreenIpc({
    handle: (channel, fn) => handlers.set(channel, fn as (...args: never[]) => unknown),
    send: (channel, payload) => sent.push({ channel, payload }),
    settings: () => ({ ...DEFAULT_SETTINGS, ...over }),
    adb,
    scrcpy
  })
  const call = (channel: string, arg: string): unknown =>
    (handlers.get(channel) as ((a: string) => unknown) | undefined)?.(arg)
  return { adb, handlers, sent, spawned, ipc, call }
}

describe('registerPhoneScreenIpc', () => {
  it('세 채널을 렌더러 전용으로 등록한다', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.phoneScreenStart, IPC.phoneScreenStop, IPC.phoneOpenWindow].sort()
    )
  })

  it('screenStart 가 스트림을 열고 청크를 렌더러로 보낸다', async () => {
    const { adb, sent, call } = setup()
    call(IPC.phoneScreenStart, SERIAL)
    await flush()
    adb.push(
      Buffer.concat([
        Buffer.from([0, 0, 0, 1, 7, 0x11]),
        Buffer.from([0, 0, 0, 1, 5, 0x22]),
        Buffer.from([0, 0, 0, 1, 1, 0x33])
      ])
    )
    const modes = sent.filter((s) => s.channel === IPC.phoneScreenMode)
    const chunks = sent.filter((s) => s.channel === IPC.phoneScreenChunk)
    expect(modes[0].payload).toEqual({ serial: SERIAL, mode: 'video' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].payload).toMatchObject({ serial: SERIAL, mode: 'video', keyframe: true })
    call(IPC.phoneScreenStop, SERIAL)
  })

  it('screenStop 이 전송을 끄고 mode:null 을 알린다', async () => {
    const { adb, sent, call } = setup()
    call(IPC.phoneScreenStart, SERIAL)
    await flush()
    call(IPC.phoneScreenStop, SERIAL)
    expect(adb.liveStreams).toBe(0)
    expect(sent.at(-1)).toEqual({
      channel: IPC.phoneScreenMode,
      payload: { serial: SERIAL, mode: null }
    })
  })

  it('openWindow 가 scrcpy 창을 띄운다', () => {
    const { spawned, call } = setup()
    call(IPC.phoneOpenWindow, SERIAL)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toContain('--video-codec=h264')
  })

  it('dispose 가 스트림과 창을 모두 정리한다', async () => {
    const { adb, ipc, call } = setup()
    call(IPC.phoneScreenStart, SERIAL)
    call(IPC.phoneOpenWindow, SERIAL)
    await flush()
    ipc.dispose()
    expect(adb.liveStreams).toBe(0)
    expect(ipc.windows.isOpen(SERIAL)).toBe(false)
  })

  it('설정의 해상도를 그대로 screenrecord 인자에 넘긴다', async () => {
    const { adb, call } = setup({ phoneScreenMaxSize: 720 })
    call(IPC.phoneScreenStart, SERIAL)
    await flush()
    expect(adb.streamArgs[0].join(' ')).toContain('--size 720x1600')
    call(IPC.phoneScreenStop, SERIAL)
  })
})
