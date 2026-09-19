// adb 경로 탐지와 명령 조립. 여기에는 프로세스 실행 코드가 없다(process.ts 가 담당).
// 전부 순수 함수라 폰 없이 테스트한다

import { delimiter, join } from 'node:path'
import type { PhoneTransport, PhoneState } from '../../shared/phone'

// 실행기 타입은 process.ts 가 원본이다. 위 계층이 한 파일만 보게 여기서도 다시 내보낸다
// (타입 전용 재수출이라 adb.ts 는 여전히 child_process 를 끌어오지 않는다)
export type { AdbResult, AdbRunner } from './process'

export interface RawDevice {
  serial: string
  state: PhoneState
  model: string
  transport: PhoneTransport
}

// 경로 자동 찾기 후보(앞에서부터 먼저 존재하는 것을 쓴다).
// 개인 PC 절대경로는 두지 않는다 — 앱 데이터 설치본 → PATH → 아래 후보 순서로 찾는다
export const ADB_CANDIDATES = [
  `${process.env.LOCALAPPDATA ?? ''}\\Android\\Sdk\\platform-tools\\adb.exe`,
  `${process.env.USERPROFILE ?? ''}\\Downloads\\pt\\platform-tools\\adb.exe`,
  `${process.env.USERPROFILE ?? ''}\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe`
]

export const SCRCPY_CANDIDATES = [
  `${process.env.USERPROFILE ?? ''}\\Downloads\\pt\\scrcpy-win64-v4.1\\scrcpy.exe`
]

/** 앱이 설치한 실행 파일의 자리(tools-install.ts 가 이 모양으로 푼다) */
export function installedToolPath(toolsRoot: string, exe: 'adb.exe' | 'scrcpy.exe'): string {
  const folder = exe === 'adb.exe' ? 'platform-tools' : 'scrcpy'
  return join(toolsRoot, folder, exe)
}

/** PATH 에 등록된 폴더마다 실행 파일 하나씩 후보로 만든다 */
export function pathCandidates(pathEnv: string, exe: string): string[] {
  return pathEnv
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((dir) => join(dir, exe))
}

export interface ToolLookup {
  /** 설정에 이미 적혀 있는 경로(비어 있으면 무시) */
  settingsPath?: string
  /** 앱 데이터 설치 폴더 */
  toolsRoot?: string
  /** process.env.PATH */
  pathEnv?: string
}

/**
 * 탐지 순서대로 후보를 늘어놓는다: 설정 경로 → 앱 데이터 설치본 → PATH → 기존 후보.
 * 실제로 있는지는 보지 않는다(detectAdbPath 가 앞에서부터 확인한다)
 */
export function toolCandidates(exe: 'adb.exe' | 'scrcpy.exe', lookup: ToolLookup = {}): string[] {
  const fallback = exe === 'adb.exe' ? ADB_CANDIDATES : SCRCPY_CANDIDATES
  return [
    ...(lookup.settingsPath ? [lookup.settingsPath] : []),
    ...(lookup.toolsRoot ? [installedToolPath(lookup.toolsRoot, exe)] : []),
    ...pathCandidates(lookup.pathEnv ?? '', exe),
    ...fallback
  ].filter(Boolean)
}

// 와이파이 연결은 serial 이 'ip:port' 꼴이다
const WIFI_SERIAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/

export function isWifiSerial(serial: string): boolean {
  return WIFI_SERIAL_RE.test(serial)
}

/** 후보 중 처음 존재하는 경로. 하나도 없으면 빈 문자열 */
export function detectAdbPath(candidates: string[], exists: (p: string) => boolean): string {
  for (const c of candidates) {
    if (c && exists(c)) return c
  }
  return ''
}

/** `adb devices -l` 출력 파싱 */
export function parseDevices(stdout: string): RawDevice[] {
  const out: RawDevice[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    if (trimmed.startsWith('*') || trimmed.startsWith('adb server')) continue
    const parts = trimmed.split(/\s+/)
    const serial = parts[0]
    const rawState = parts[1] ?? ''
    if (!serial || !rawState) continue
    const model = /(?:^|\s)model:(\S+)/.exec(trimmed)?.[1]?.replace(/_/g, ' ') ?? ''
    out.push({
      serial,
      state: toState(rawState),
      model,
      transport: isWifiSerial(serial) ? 'wifi' : 'usb'
    })
  }
  return out
}

function toState(raw: string): PhoneState {
  if (raw === 'device') return 'online'
  if (raw === 'unauthorized') return 'unauthorized'
  return 'offline'
}

/**
 * `adb -s <serial> shell <command>` 인자 배열.
 * 문자열을 넘기면 공백으로 쪼개고, 배열을 넘기면 그대로 쓴다.
 * `content query --uri content://sms/inbox` 처럼 쪼개면 안 되는 인자는 배열로 넘긴다
 */
export function shellArgs(serial: string, command: string | string[]): string[] {
  const rest = typeof command === 'string' ? command.split(' ').filter(Boolean) : command
  return ['-s', serial, 'shell', ...rest]
}

/** exec-out(바이너리 stdout) 용 인자 배열 */
export function execOutArgs(serial: string, command: string[]): string[] {
  return ['-s', serial, 'exec-out', ...command]
}
