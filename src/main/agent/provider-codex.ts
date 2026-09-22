// Codex 구독 경로 어댑터. OpenAI Codex CLI 를 백엔드로 써서 프롬프트 1건을 실행한다.
//
// 확인한 사실(이 PC 의 codex-cli 0.150.1 에서 `codex --help` · `codex exec --help` 실행):
//  - 비대화 실행은 `codex exec [PROMPT]`, `--json` 을 주면 이벤트를 JSONL 로 뿜는다
//  - 프롬프트를 인자로 줘도 stdin 을 계속 읽으므로(`Reading additional input from stdin...`)
//    호출부가 stdin 을 반드시 닫아야 한다 — 여기서는 프롬프트를 stdin 으로 넣고 바로 닫는다
//  - 실제 이벤트 봉투: {"type":"thread.started",...} / {"type":"turn.started"} /
//    {"type":"item.completed","item":{...}} / {"type":"turn.completed"|"turn.failed"} /
//    {"type":"error","message":"..."}
//  - item.type 은 agent_message · reasoning · command_execution · file_change ·
//    mcp_tool_call · web_search · todo_list · error
//
// 도구 연동 범위: samba 도구는 Claude Agent SDK 의 **인프로세스** MCP 서버(createSdkMcpServer)라
// 별도 프로세스인 codex 가 붙을 수 없다. 그래서 이 어댑터는 `-c mcp_servers.*` 로 **외부 stdio
// MCP 서버가 주어졌을 때만** 도구를 연결하고, 없으면 텍스트 응답 경로로만 동작한다.

import { spawn } from 'node:child_process'
import { resolveCliBin } from '../ai/cli-bin'

/** codex 에 넘길 실행 입력 */
export interface CodexInput {
  prompt: string
  systemPrompt: string
  model: string
  /** 도구를 붙일 외부 stdio MCP 서버(없으면 도구 없이 텍스트만) */
  mcpServer?: { name: string; command: string; args: string[] }
  abort: AbortController
  cwd?: string
}

/** 어댑터가 밖으로 내보내는 정규화된 사건 */
export type CodexEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; label: string; ok: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; ok: boolean; message?: string }

/** 자식 프로세스 최소 모양(테스트에서 가짜 프로세스를 주입한다) */
export interface CodexChild {
  stdout: AsyncIterable<string | Buffer> | NodeJS.ReadableStream
  stderr?: NodeJS.ReadableStream
  stdin?: { write: (chunk: string) => void; end: () => void } | null
  kill: (signal?: NodeJS.Signals) => boolean
  on: (event: 'close' | 'error', listener: (arg: never) => void) => unknown
}

export type CodexSpawn = (command: string, args: string[], cwd?: string) => CodexChild

export const CODEX_BIN = 'codex'

/**
 * `codex exec` 인자. 승인·샌드박스는 가장 좁게 잡는다 —
 * 브라우저 조작은 samba 도구가 하고, codex 쪽 셸 실행은 읽기 전용으로 묶어 둔다
 */
export function buildCodexArgs(input: Pick<CodexInput, 'model' | 'mcpServer'>): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    // 사용자/프로젝트 config.toml 의 훅·MCP 를 상속하지 않는다(우리 설정만 쓴다)
    '--ignore-user-config',
    '--sandbox',
    'read-only'
  ]
  if (input.model.trim()) args.push('-m', input.model.trim())
  if (input.mcpServer) {
    const { name, command, args: serverArgs } = input.mcpServer
    // TOML 인라인 테이블로 서버 하나를 얹는다(-c mcp_servers.<name>={...})
    const toml = `{command=${JSON.stringify(command)},args=[${serverArgs
      .map((a) => JSON.stringify(a))
      .join(',')}]}`
    args.push('-c', `mcp_servers.${name}=${toml}`)
  }
  return args
}

/**
 * codex 에는 시스템 프롬프트를 따로 넘기는 안정된 통로가 없어(설정 키에 의존하지 않는다)
 * 지시문을 프롬프트 앞머리에 붙여 stdin 으로 한 번에 넣는다
 */
export function composeCodexPrompt(systemPrompt: string, prompt: string): string {
  const head = systemPrompt.trim()
  return head ? `${head}\n\n---\n\n${prompt}` : prompt
}

/** JSONL 한 줄 → 정규화된 사건들(모르는 줄은 조용히 버린다) */
export function parseCodexLine(line: string): CodexEvent[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return []
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object') return []
  const event = raw as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'error') {
    return [{ type: 'error', message: str(event.message) || 'codex error' }]
  }
  if (type === 'turn.failed') {
    const error = event.error
    const message =
      error && typeof error === 'object' ? str((error as Record<string, unknown>).message) : ''
    return [{ type: 'done', ok: false, message: message || 'turn.failed' }]
  }
  if (type === 'turn.completed') return [{ type: 'done', ok: true }]
  if (type === 'item.completed') return itemEvents(event.item)
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// item.completed 하나를 화면 사건으로 바꾼다. 추론(reasoning)은 화면에 올리지 않는다
function itemEvents(item: unknown): CodexEvent[] {
  if (!item || typeof item !== 'object') return []
  const record = item as Record<string, unknown>
  const type = str(record.type)
  if (type === 'agent_message') {
    const text = str(record.text) || str(record.message)
    return text ? [{ type: 'text', text }] : []
  }
  if (type === 'error') {
    return [{ type: 'error', message: str(record.message) || 'codex item error' }]
  }
  if (type === 'mcp_tool_call') {
    const label = [str(record.server), str(record.tool)].filter(Boolean).join('.') || 'tool'
    return [{ type: 'step', label, ok: str(record.status) !== 'failed' }]
  }
  if (type === 'command_execution') {
    const label = str(record.command) || 'command'
    return [{ type: 'step', label, ok: str(record.status) !== 'failed' }]
  }
  if (type === 'web_search') {
    return [{ type: 'step', label: str(record.query) || 'web_search', ok: true }]
  }
  return []
}

/** 버퍼에 쌓인 텍스트를 줄 단위로 끊는다(마지막 조각은 다음 청크를 기다린다) */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.replace(/\r$/, '')), rest }
}

function defaultSpawn(command: string, args: string[], cwd?: string): CodexChild {
  // Windows 의 npm 셔틀(codex.cmd)은 spawn 이름만으로는 못 돌리므로 실제 실행 파일(node + .js)로 푼다
  const cli = resolveCliBin(command)
  const child = spawn(cli.command, [...cli.prefixArgs, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return child as unknown as CodexChild
}

/**
 * Codex CLI 로 프롬프트 1건을 실행하고 사건을 순서대로 흘려보낸다.
 * 중단(abort)되면 자식 프로세스를 죽이고 스트림을 끝낸다
 */
export async function* runCodex(
  input: CodexInput,
  spawnImpl: CodexSpawn = defaultSpawn
): AsyncGenerator<CodexEvent> {
  const args = buildCodexArgs(input)
  let child: CodexChild
  try {
    child = spawnImpl(CODEX_BIN, args, input.cwd)
  } catch (e) {
    yield { type: 'done', ok: false, message: e instanceof Error ? e.message : String(e) }
    return
  }
  const onAbort = (): void => {
    try {
      child.kill()
    } catch {
      // 이미 끝난 프로세스는 무시한다
    }
  }
  // 이미 중단된 뒤에 들어온 실행이면 리스너가 불리지 않으므로 여기서 바로 정리한다
  if (input.abort.signal.aborted) onAbort()
  else input.abort.signal.addEventListener('abort', onAbort, { once: true })
  // 프롬프트는 stdin 으로 넣고 곧바로 닫는다 — 닫지 않으면 codex 가 입력을 계속 기다린다
  try {
    child.stdin?.write(composeCodexPrompt(input.systemPrompt, input.prompt))
    child.stdin?.end()
  } catch {
    // stdin 이 이미 닫혀 있으면 인자 프롬프트가 없으므로 실패로 끝난다
  }
  let buffer = ''
  let settled = false
  try {
    for await (const chunk of child.stdout as AsyncIterable<string | Buffer>) {
      if (input.abort.signal.aborted) break
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const { lines, rest } = splitLines(buffer)
      buffer = rest
      for (const line of lines) {
        for (const event of parseCodexLine(line)) {
          if (event.type === 'done') settled = true
          yield event
        }
      }
    }
    for (const event of parseCodexLine(buffer)) {
      if (event.type === 'done') settled = true
      yield event
    }
  } finally {
    input.abort.signal.removeEventListener('abort', onAbort)
  }
  // turn.completed/turn.failed 없이 끊긴 경우(프로세스 사망)도 한 번은 끝을 알린다
  if (!settled && !input.abort.signal.aborted) {
    yield { type: 'done', ok: false, message: 'codex_stream_closed' }
  }
}
