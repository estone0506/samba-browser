import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  buildCodexArgs,
  composeCodexPrompt,
  parseCodexLine,
  runCodex,
  splitLines,
  type CodexChild,
  type CodexEvent
} from '../src/main/agent/provider-codex'

// 실제 `codex exec --json` 이 뿜은 줄(이 PC 의 codex-cli 0.150.1 로 확인한 봉투 모양)
const FIXTURE = [
  '{"type":"thread.started","thread_id":"01a0b7a9-b0c5-7b02-924a-000b608f2083"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"생각 중"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"안녕하세요"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"samba","tool":"open_url","status":"completed"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}'
]

describe('buildCodexArgs — 실제로 확인한 인자만 쓴다', () => {
  it('비대화 JSONL 실행 인자를 만든다', () => {
    const args = buildCodexArgs({ model: 'gpt-5.6' })
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('--ignore-user-config')
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6']))
  })

  it('모델이 비어 있으면 -m 을 붙이지 않는다', () => {
    expect(buildCodexArgs({ model: '  ' })).not.toContain('-m')
  })

  it('외부 stdio MCP 서버가 있을 때만 -c mcp_servers 를 얹는다', () => {
    expect(buildCodexArgs({ model: 'gpt-5.6' }).join(' ')).not.toContain('mcp_servers')
    const args = buildCodexArgs({
      model: 'gpt-5.6',
      mcpServer: { name: 'samba', command: 'node', args: ['server.js'] }
    })
    const cfg = args[args.indexOf('-c', args.indexOf('mcp_servers') - 1)]
    expect(cfg).toBe('-c')
    expect(args.join(' ')).toContain('mcp_servers.samba={command="node",args=["server.js"]}')
  })

  it('시스템 프롬프트는 프롬프트 앞머리로 합쳐 stdin 으로 넣는다', () => {
    expect(composeCodexPrompt('규칙', '할 일')).toBe('규칙\n\n---\n\n할 일')
    expect(composeCodexPrompt('   ', '할 일')).toBe('할 일')
  })
})

describe('parseCodexLine — JSONL 사건 파싱', () => {
  it('agent_message 만 텍스트로 올리고 reasoning 은 버린다', () => {
    const events = FIXTURE.flatMap(parseCodexLine)
    expect(events).toEqual([
      { type: 'text', text: '안녕하세요' },
      { type: 'step', label: 'samba.open_url', ok: true },
      { type: 'done', ok: true }
    ])
  })

  it('turn.failed · error 는 실패로 옮긴다', () => {
    expect(parseCodexLine('{"type":"error","message":"네트워크 끊김"}')).toEqual([
      { type: 'error', message: '네트워크 끊김' }
    ])
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"한도 초과"}}')).toEqual([
      { type: 'done', ok: false, message: '한도 초과' }
    ])
  })

  it('실패한 도구 호출은 ok:false 로 표시한다', () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"failed"}}'
      )
    ).toEqual([{ type: 'step', label: 'ls', ok: false }])
  })

  it('JSON 이 아니거나 모르는 사건은 조용히 버린다', () => {
    expect(parseCodexLine('Reading additional input from stdin...')).toEqual([])
    expect(parseCodexLine('{깨진')).toEqual([])
    expect(parseCodexLine('{"type":"item.started","item":{"type":"agent_message"}}')).toEqual([])
  })

  it('splitLines 는 끊긴 마지막 조각을 다음 청크로 넘긴다', () => {
    expect(splitLines('a\r\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
  })
})

// 가짜 codex 프로세스: 준 줄들을 그대로 stdout 으로 흘린다
function fakeChild(chunks: string[]): CodexChild & { written: string[]; killed: boolean } {
  const emitter = new EventEmitter()
  const child = {
    stdout: (async function* () {
      for (const c of chunks) yield c
    })(),
    stdin: {
      write: (chunk: string) => child.written.push(chunk),
      end: () => child.written.push('<end>')
    },
    kill: (): boolean => {
      child.killed = true
      return true
    },
    on: emitter.on.bind(emitter),
    written: [] as string[],
    killed: false
  }
  return child as unknown as CodexChild & { written: string[]; killed: boolean }
}

async function collect(stream: AsyncGenerator<CodexEvent>): Promise<CodexEvent[]> {
  const out: CodexEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('runCodex — 스트림 어댑터', () => {
  it('프롬프트를 stdin 으로 넣고 바로 닫는다(닫지 않으면 codex 가 입력을 기다린다)', async () => {
    const child = fakeChild([FIXTURE.join('\n') + '\n'])
    const events = await collect(
      runCodex(
        {
          prompt: '할 일',
          systemPrompt: '규칙',
          model: 'gpt-5.6',
          abort: new AbortController()
        },
        () => child
      )
    )
    expect(child.written).toEqual(['규칙\n\n---\n\n할 일', '<end>'])
    expect(events.at(-1)).toEqual({ type: 'done', ok: true })
  })

  it('청크가 줄 중간에서 끊겨도 한 사건으로 합친다', async () => {
    const joined = FIXTURE.join('\n') + '\n'
    const child = fakeChild([joined.slice(0, 120), joined.slice(120)])
    const events = await collect(
      runCodex(
        { prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() },
        () => child
      )
    )
    expect(events).toContainEqual({ type: 'text', text: '안녕하세요' })
  })

  it('끝 사건 없이 스트림이 닫히면 실패로 마무리한다', async () => {
    const child = fakeChild(['{"type":"turn.started"}\n'])
    const events = await collect(
      runCodex(
        { prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() },
        () => child
      )
    )
    expect(events).toEqual([{ type: 'done', ok: false, message: 'codex_stream_closed' }])
  })

  it('중단하면 자식 프로세스를 죽인다', async () => {
    const child = fakeChild([FIXTURE.join('\n') + '\n'])
    const abort = new AbortController()
    abort.abort()
    await collect(runCodex({ prompt: 'p', systemPrompt: '', model: '', abort }, () => child))
    expect(child.killed).toBe(true)
  })

  it('실행 자체가 실패하면(설치 안 됨) 실패 사건 하나로 끝난다', async () => {
    const events = await collect(
      runCodex({ prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() }, () => {
        throw new Error('ENOENT')
      })
    )
    expect(events).toEqual([{ type: 'done', ok: false, message: 'ENOENT' }])
  })
})
