// 테스트용 가짜 adb. 실제 프로세스를 절대 띄우지 않는다.
// 인자 배열을 공백으로 이어 붙인 문자열을 키로 응답을 고른다

import type { AdbResult, AdbRunner } from '../../src/main/phone/process'

export class FakeAdb implements AdbRunner {
  readonly calls: string[][] = []
  private replies = new Map<string, AdbResult>()
  private binaries = new Map<string, Buffer>()
  private streams: ((chunk: Buffer) => void)[] = []

  /** 부분 일치(포함)로 응답을 지정한다 */
  reply(match: string, stdout: string, code = 0): void {
    this.replies.set(match, { code, stdout, stderr: '' })
  }

  replyBinary(match: string, data: Buffer): void {
    this.binaries.set(match, data)
  }

  run(args: string[]): Promise<AdbResult> {
    this.calls.push(args)
    const key = args.join(' ')
    for (const [match, res] of this.replies) {
      if (key.includes(match)) return Promise.resolve(res)
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }

  runBinary(args: string[]): Promise<Buffer> {
    this.calls.push(args)
    const key = args.join(' ')
    for (const [match, data] of this.binaries) {
      if (key.includes(match)) return Promise.resolve(data)
    }
    return Promise.resolve(Buffer.alloc(0))
  }

  stream(
    args: string[],
    onData: (chunk: Buffer) => void,
    onEnd: (code: number | null) => void
  ): () => void {
    this.calls.push(args)
    this.streams.push(onData)
    return () => onEnd(0)
  }

  /** 테스트에서 스트림 청크를 흘려보낸다 */
  push(chunk: Buffer): void {
    for (const s of this.streams) s(chunk)
  }
}
