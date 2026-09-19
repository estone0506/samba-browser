// scrcpy "큰 창으로 열기" — 앱 안 임베드는 ScreenStream 이 담당하고,
// 사용자가 폰을 직접 오래 만질 때만 별도 창을 띄운다.
// 프로세스 실행은 주입받은 ProcessSpawner 로만 한다(테스트는 가짜를 쓴다)

import type { ScreenFps, ScreenSize } from '../../shared/phone'
import type { ProcessSpawner } from './process'

/** 큰 창의 영상 비트레이트 */
export const WINDOW_BIT_RATE = '2M'

export interface ScrcpyDeps {
  /** scrcpy 실행 파일에 묶인 실행기 */
  spawn: ProcessSpawner
  /** 설정의 scrcpyPath. 비어 있으면 열지 않는다 */
  path: () => string
  size: () => ScreenSize
  fps: () => ScreenFps
  /** 창이 닫혔을 때(프로세스 종료) 알림 */
  onClosed?: (serial: string) => void
}

/** scrcpy 인자 배열(순수) */
export function scrcpyArgs(serial: string, size: ScreenSize, fps: ScreenFps): string[] {
  return [
    '-s',
    serial,
    '--video-codec=h264',
    `--max-size=${size}`,
    `--max-fps=${fps}`,
    '--no-audio',
    '--stay-awake',
    `--video-bit-rate=${WINDOW_BIT_RATE}`
  ]
}

/** 폰별로 큰 창 하나만 유지한다 */
export class ScrcpyWindows {
  private windows = new Map<string, () => void>()

  constructor(private deps: ScrcpyDeps) {}

  /** 이 폰의 큰 창이 떠 있는가 */
  isOpen(serial: string): boolean {
    return this.windows.has(serial)
  }

  /** 큰 창을 연다. 이미 떠 있으면 아무것도 하지 않는다 */
  open(serial: string): void {
    if (this.windows.has(serial)) return
    if (!this.deps.path()) throw new Error('scrcpy path is not set')
    const args = scrcpyArgs(serial, this.deps.size(), this.deps.fps())
    const cancel = this.deps.spawn(
      args,
      // scrcpy 는 자기 창에 그린다. stdout 은 쓰지 않는다
      () => {},
      () => {
        this.windows.delete(serial)
        this.deps.onClosed?.(serial)
      }
    )
    this.windows.set(serial, cancel)
  }

  close(serial: string): void {
    const cancel = this.windows.get(serial)
    if (!cancel) return
    this.windows.delete(serial)
    cancel()
  }

  closeAll(): void {
    for (const serial of [...this.windows.keys()]) this.close(serial)
  }
}
