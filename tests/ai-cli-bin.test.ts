// Windows npm 셔틀(codex.cmd)을 node + .js 로 풀어 실행하는 규칙
import { describe, it, expect } from 'vitest'
import { resolveCliBin, scriptOfNpmShim, type CliResolveDeps } from '../src/main/ai/cli-bin'

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SHIM = [
  '@ECHO off',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
].join('\r\n')

function deps(over: Partial<CliResolveDeps> & { files?: string[] } = {}): CliResolveDeps {
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()))
  return {
    platform: over.platform ?? 'win32',
    env: over.env ?? {
      PATH: 'C:\\Windows;C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming'
    },
    exists: over.exists ?? ((p) => files.has(p.toLowerCase())),
    readFile: over.readFile ?? (() => SHIM)
  }
}

describe('resolveCliBin', () => {
  it('Windows 가 아니면 이름 그대로', () => {
    expect(resolveCliBin('codex', deps({ platform: 'linux' }))).toEqual({
      command: 'codex',
      prefixArgs: []
    })
  })

  it('npm 전역 폴더의 codex.cmd 를 찾아 셔틀 안의 .js 를 node 로 돌린다(실기: Codex 가 있는데 "설치되지 않음")', () => {
    const r = resolveCliBin(
      'codex',
      deps({
        files: [`${NPM}\\codex.cmd`, `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, NODE]
      })
    )
    expect(r.command).toBe(NODE)
    expect(r.prefixArgs).toEqual([`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`])
  })

  it('.exe 가 있으면 그것을 우선 쓴다(claude.exe 처럼 네이티브 설치)', () => {
    const r = resolveCliBin(
      'claude',
      deps({
        env: { PATH: 'C:\\Users\\u\\.local\\bin' },
        files: ['C:\\Users\\u\\.local\\bin\\claude.exe']
      })
    )
    expect(r).toEqual({ command: 'C:\\Users\\u\\.local\\bin\\claude.exe', prefixArgs: [] })
  })

  it('아무것도 못 찾으면 이름 그대로(예전과 같은 실패)', () => {
    expect(resolveCliBin('codex', deps())).toEqual({ command: 'codex', prefixArgs: [] })
  })

  it('셔틀의 .js 가 없으면 셔틀을 믿지 않는다', () => {
    expect(resolveCliBin('codex', deps({ files: [`${NPM}\\codex.cmd`] }))).toEqual({
      command: 'codex',
      prefixArgs: []
    })
  })
})

describe('scriptOfNpmShim', () => {
  it('"%dp0%\\...\\x.js" 를 뽑는다', () => {
    expect(scriptOfNpmShim(SHIM, 'C:\\npm')).toBe(
      'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    )
  })
  it('.js 가 없으면 null', () => {
    expect(scriptOfNpmShim('@ECHO off\r\n"%dp0%\\foo.exe" %*', 'C:\\npm')).toBeNull()
  })
})
