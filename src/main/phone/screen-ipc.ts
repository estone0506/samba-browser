// 폰 화면 IPC 배선. handlers.ts 가 이 함수 하나만 부르면 되도록 묶어 두었다.
// electron 을 직접 import 하지 않고 등록 함수를 주입받아 테스트 가능하게 남긴다

import { IPC } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import { createAdbRunner, createSpawner, type AdbRunner } from './process'
import { ScreenStream } from './screen'
import { ScrcpyWindows } from './scrcpy'

export interface PhoneScreenIpcDeps {
  /** 렌더러 전용 invoke 채널 등록(발신자 검증 포함) */
  handle: <A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>) => void
  /** main → renderer 통지 */
  send: (channel: string, payload: unknown) => void
  settings: () => Settings
  /** 테스트에서 갈아끼운다. 없으면 실제 adb 실행기를 만든다 */
  adb?: AdbRunner
  scrcpy?: ScrcpyWindows
}

export interface PhoneScreenIpc {
  stream: ScreenStream
  windows: ScrcpyWindows
  dispose: () => void
}

export function registerPhoneScreenIpc(deps: PhoneScreenIpcDeps): PhoneScreenIpc {
  const settings = deps.settings
  const adb = deps.adb ?? createAdbRunner(() => settings().adbPath)

  const stream = new ScreenStream({
    adb,
    size: () => settings().phoneScreenMaxSize,
    fps: () => settings().phoneScreenFps,
    onChunk: (c) =>
      deps.send(IPC.phoneScreenChunk, {
        serial: c.serial,
        mode: c.mode,
        keyframe: c.keyframe,
        data: c.data
      }),
    onModeChange: (serial, mode) => deps.send(IPC.phoneScreenMode, { serial, mode }),
    now: () => Date.now()
  })

  const windows =
    deps.scrcpy ??
    new ScrcpyWindows({
      spawn: createSpawner(() => settings().scrcpyPath),
      path: () => settings().scrcpyPath,
      size: () => settings().phoneScreenMaxSize,
      fps: () => settings().phoneScreenFps,
      onClosed: (serial) => deps.send(IPC.phoneScreenMode, { serial, mode: stream.mode(serial) })
    })

  deps.handle(IPC.phoneScreenStart, (serial: string) => {
    stream.start(serial)
  })

  deps.handle(IPC.phoneScreenStop, (serial: string) => {
    stream.stop(serial)
    deps.send(IPC.phoneScreenMode, { serial, mode: null })
  })

  deps.handle(IPC.phoneOpenWindow, (serial: string) => {
    windows.open(serial)
  })

  return {
    stream,
    windows,
    dispose: () => {
      stream.stopAll()
      windows.closeAll()
    }
  }
}
