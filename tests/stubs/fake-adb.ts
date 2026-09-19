// 테스트용 가짜 adb. 실제 프로세스를 절대 띄우지 않는다.
// 인자 배열을 공백으로 이어 붙인 문자열을 키로 응답을 고른다

import type { AdbResult, AdbRunner } from '../../src/main/phone/process'

/** 열려 있는 가짜 스트림 하나 */
interface FakeStream {
  args: string[]
  onData: (chunk: Buffer) => void
  onEnd: (code: number | null) => void
}

export class FakeAdb implements AdbRunner {
  readonly calls: string[][] = []
  /** 지금까지 열린 스트림의 인자(끝난 것도 남는다) */
  readonly streamArgs: string[][] = []
  private replies = new Map<string, AdbResult>()
  private binaries = new Map<string, Buffer>()
  private streams: FakeStream[] = []

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
    this.streamArgs.push(args)
    const entry: FakeStream = { args, onData, onEnd }
    this.streams.push(entry)
    return () => {
      this.remove(entry)
      onEnd(0)
    }
  }

  /** 테스트에서 스트림 청크를 흘려보낸다(살아 있는 스트림 전부) */
  push(chunk: Buffer): void {
    for (const s of [...this.streams]) s.onData(chunk)
  }

  /** 지금 살아 있는 스트림 수 */
  get liveStreams(): number {
    return this.streams.length
  }

  /** 스트림이 스스로 끝난 상황(세션 상한·기기 끊김)을 흉내 낸다 */
  endStream(code: number | null = 0): void {
    const entry = this.streams[this.streams.length - 1]
    if (!entry) return
    this.remove(entry)
    entry.onEnd(code)
  }

  private remove(entry: FakeStream): void {
    const i = this.streams.indexOf(entry)
    if (i >= 0) this.streams.splice(i, 1)
  }
}
