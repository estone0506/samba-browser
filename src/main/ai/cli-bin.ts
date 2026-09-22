// CLI 실행 파일 찾기 — Windows 의 npm 전역 명령(codex 등)은 `codex.cmd` 셔틀이라
// execFile/spawn 에 이름만 주면 ENOENT 로 "설치되지 않음"이 된다(실기: Codex 데스크톱·CLI 가 있는데 미설치 표시).
// 셸(shell: true)로 돌리면 인자에 든 문자열이 명령줄 해석을 타므로 쓰지 않고,
// 셔틀이 부르는 .js 를 읽어 node 로 직접 실행한다(인자는 그대로 배열로 전달 — 명령줄 해석 없음)

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

export interface ResolvedCli {
  /** 실제로 spawn 할 실행 파일(또는 PATH 의 이름) */
  command: string
  /** 사용자 인자 앞에 붙일 인자(node 로 .js 를 부를 때 그 스크립트 경로) */
  prefixArgs: string[]
}

export interface CliResolveDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
  readFile: (path: string) => string
}

const defaultDeps: CliResolveDeps = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8')
}

/** PATH 폴더들 + npm 전역 폴더(앱이 바로가기로 떠서 PATH 에 npm 폴더가 없을 때 대비) */
function searchDirs(deps: CliResolveDeps): string[] {
  const dirs = (deps.env.PATH ?? deps.env.Path ?? '').split(delimiter).filter((d) => d !== '')
  const appData = deps.env.APPDATA
  if (appData) dirs.push(join(appData, 'npm'))
  return dirs
}

/** npm 셔틀(.cmd)이 부르는 .js 경로. `"%dp0%\node_modules\...\bin\x.js"` 꼴에서 뽑는다 */
export function scriptOfNpmShim(shim: string, dir: string): string | null {
  const m = /"%dp0%\\([^"]+\.js)"/.exec(shim) ?? /"%~dp0\\?([^"]+\.js)"/.exec(shim)
  return m ? join(dir, m[1]) : null
}

/** node 실행 파일. 셔틀 옆 → PATH 순으로 찾고, 없으면 이름 그대로 */
function findNode(dir: string, deps: CliResolveDeps): string {
  const beside = join(dir, 'node.exe')
  if (deps.exists(beside)) return beside
  for (const d of searchDirs(deps)) {
    const p = join(d, 'node.exe')
    if (deps.exists(p)) return p
  }
  return 'node'
}

/**
 * `bin` 을 실제로 실행할 방법을 정한다.
 * - Windows 가 아니면 이름 그대로(PATH 해석은 OS 가 한다)
 * - Windows: `<dir>\bin.exe` 가 있으면 그것, `<dir>\bin.cmd`(npm 셔틀)면 그 안의 .js 를 node 로.
 *   둘 다 못 찾으면 이름 그대로 돌려준다(예전과 같은 실패)
 */
export function resolveCliBin(bin: string, deps: CliResolveDeps = defaultDeps): ResolvedCli {
  if (deps.platform !== 'win32') return { command: bin, prefixArgs: [] }
  for (const dir of searchDirs(deps)) {
    const exe = join(dir, `${bin}.exe`)
    if (deps.exists(exe)) return { command: exe, prefixArgs: [] }
    const cmd = join(dir, `${bin}.cmd`)
    if (!deps.exists(cmd)) continue
    let script: string | null = null
    try {
      script = scriptOfNpmShim(deps.readFile(cmd), dirname(cmd))
    } catch {
      script = null
    }
    if (script && deps.exists(script)) return { command: findNode(dir, deps), prefixArgs: [script] }
  }
  return { command: bin, prefixArgs: [] }
}
