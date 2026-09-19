// adb 실행기. child_process 를 쓰는 파일은 이 하나뿐이고,
// 그 위의 모든 모듈은 AdbRunner 인터페이스만 본다(테스트는 가짜 구현을 쓴다)

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface AdbResult {
  code: number
  stdout: string
  stderr: string
}

/** 오래 도는 외부 프로세스를 띄우는 능력(screenrecord·scrcpy). 종료 함수를 돌려준다 */
export type ProcessSpawner = (
  args: string[],
  onData: (chunk: Buffer) => void,
  onEnd: (code: number | null) => void
) => () => void

export interface AdbRunner {
  // adb 인자 배열을 그대로 실행한다(serial 지정은 호출부가 -s 로 붙인다)
  run: (args: string[], timeoutMs?: number) => Promise<AdbResult>
  // stdout 을 바이너리로 그대로 받는 실행(screencap·screenrecord)
  runBinary: (args: string[], timeoutMs?: number) => Promise<Buffer>
  // 오래 도는 스트림(screenrecord). 종료 함수를 돌려준다
  stream: ProcessSpawner
}

// 한 번짜리 명령 기본 상한 15초(uiautomator dump 가 느린 기기가 있다)
const DEFAULT_TIMEOUT_MS = 15_000
// stdout 상한 32MB(screencap PNG 여유)
const MAX_BUFFER = 32 * 1024 * 1024

export function createAdbRunner(adbPath: () => string): AdbRunner {
  const bin = (): string => {
    const p = adbPath()
    if (!p) throw new Error('adb path is not set')
    return p
  }

  return {
    run: (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise((resolve) => {
        execFile(
          bin(),
          args,
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
            resolve({ code, stdout: String(stdout), stderr: String(stderr) })
          }
        )
      }),

    runBinary: (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        execFile(
          bin(),
          args,
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'buffer', windowsHide: true },
          (err, stdout) => {
            if (err && (!stdout || stdout.length === 0)) reject(err)
            else resolve(Buffer.from(stdout))
          }
        )
      }),

    stream: (args, onData, onEnd) => {
      let child: ChildProcessWithoutNullStreams | null = spawn(bin(), args, { windowsHide: true })
      child.stdout.on('data', (c: Buffer) => onData(c))
      // stderr 는 화면 크기 안내 등 잡음이라 버린다(비밀값이 들어올 경로가 아니다)
      child.stderr.resume()
      child.on('close', (code) => {
        child = null
        onEnd(code)
      })
      return () => {
        child?.kill()
        child = null
      }
    }
  }
}
