// 폰 연동 프로그램(adb·scrcpy) 원클릭 설치.
//
// 흐름: 내려받기(진행률 통지·크기 상한) → zip 무결성 확인 → 앱 데이터에 해제(zip-slip 방지)
// → 설정(adbPath·scrcpyPath)에 실행 파일 경로 저장 → 설치 기록(tools.json)에 버전 남기기.
//
// 여기서는 프로세스를 띄우지 않는다 — 버전은 내려받은 릴리스에서 읽어 기록으로 남긴다.
// platform-tools 는 구글이 해시를 함께 주지 않아 zip 형식 검사까지만 하고,
// scrcpy 는 릴리스에 SHA256SUMS 가 있으면 대조한다

import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  PhoneToolsProgressDto,
  PhoneToolsStatusDto,
  ToolInstallStep
} from '../../shared/phone'
import { installedToolPath } from './adb'
import { safeEntryPath } from '../extensions/webstore'

/** 안드로이드 platform-tools(adb 가 들어 있다) 최신 윈도우 zip */
export const PLATFORM_TOOLS_URL =
  'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

/** scrcpy 최신 릴리스 정보 */
export const SCRCPY_LATEST_API = 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest'

/** API 를 못 부를 때(사내망 차단·한도 초과) 쓰는 고정 주소 */
export const SCRCPY_FALLBACK_VERSION = 'v4.1'
export const SCRCPY_FALLBACK_URL =
  'https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-win64-v4.1.zip'

/** 내려받기 상한 — platform-tools 는 10MB 대, scrcpy 는 50MB 대다 */
export const MAX_TOOL_BYTES = 200 * 1024 * 1024
/** 내려받기 제한 시간 */
export const TOOL_TIMEOUT_MS = 180_000
/** 해제 후 총 바이트·항목 수 상한(zip bomb 방지) */
export const MAX_UNZIPPED_BYTES = 400 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 5000

/** 앱 데이터에 남기는 설치 기록 파일 이름 */
export const TOOLS_MANIFEST = 'tools.json'

/** 설치 기록 — 버전 표시는 이 파일만 읽는다(adb.exe 를 실행하지 않는다) */
export interface ToolsManifest {
  adbVersion: string | null
  scrcpyVersion: string | null
  installedAt: number
}

/** net.fetch 만큼의 최소 형태 — 테스트는 가짜 구현을 넣는다 */
export interface ToolsResponse {
  ok: boolean
  status: number
  headers?: { get: (name: string) => string | null }
  body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null
  arrayBuffer: () => Promise<ArrayBuffer>
  text?: () => Promise<string>
}

export interface ToolsFetcher {
  (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> }
  ): Promise<ToolsResponse>
}

export interface PhoneToolsSettingsLike {
  get: () => { adbPath: string; scrcpyPath: string }
  set: (patch: { adbPath?: string; scrcpyPath?: string }) => unknown
}

export interface InstallPhoneToolsDeps {
  /** 앱 데이터의 phone-tools 폴더 */
  root: string
  fetchImpl: ToolsFetcher
  settings: PhoneToolsSettingsLike
  onProgress?: (p: PhoneToolsProgressDto) => void
}

// --- 순수 함수(내려받기 없이 테스트한다) ------------------------------------

/** zip 매직 넘버(`PK\x03\x04`) 확인 — HTML 오류 문서를 받아 놓고 푸는 일을 막는다 */
export function assertZip(buf: Buffer, label: string): void {
  if (buf.length < 4) throw new Error(`${label} 파일이 비어 있어요`)
  const magic = buf.subarray(0, 4)
  if (magic[0] !== 0x50 || magic[1] !== 0x4b || magic[2] !== 0x03 || magic[3] !== 0x04) {
    throw new Error(`${label} 내려받기가 올바르지 않아요 (zip 파일이 아니에요)`)
  }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** `<해시>  <파일이름>` 줄들에서 이 파일의 해시를 찾는다. 없으면 null */
export function parseSha256Sums(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2].trim() === fileName) return m[1].toLowerCase()
  }
  return null
}

export interface ScrcpyAsset {
  url: string
  fileName: string
  version: string
  /** 릴리스가 SHA256SUMS 를 함께 올렸을 때만 채운다 */
  sumsUrl: string | null
}

/** win64 zip 자산 이름 */
const SCRCPY_WIN64_RE = /^scrcpy-win64-.*\.zip$/i

/**
 * GitHub 릴리스 JSON 에서 win64 zip 자산을 고른다.
 * 모양이 다르거나 자산이 없으면 null 을 돌려주고 호출부가 고정 주소로 되돌아간다
 */
export function pickScrcpyAsset(release: unknown): ScrcpyAsset | null {
  if (typeof release !== 'object' || release === null) return null
  const r = release as { tag_name?: unknown; assets?: unknown }
  if (!Array.isArray(r.assets)) return null
  const assets = r.assets.filter(
    (a): a is { name: string; browser_download_url: string } =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as { name?: unknown }).name === 'string' &&
      typeof (a as { browser_download_url?: unknown }).browser_download_url === 'string'
  )
  const zip = assets.find((a) => SCRCPY_WIN64_RE.test(a.name))
  if (!zip) return null
  const sums = assets.find((a) => /^SHA256SUMS$/i.test(a.name))
  const version =
    typeof r.tag_name === 'string' && r.tag_name
      ? r.tag_name
      : (/scrcpy-win64-(.+)\.zip$/i.exec(zip.name)?.[1] ?? '')
  return {
    url: zip.browser_download_url,
    fileName: zip.name,
    version,
    sumsUrl: sums?.browser_download_url ?? null
  }
}

/** platform-tools 의 source.properties 에서 개정 번호(Pkg.Revision)를 읽는다 */
export function parsePkgRevision(text: string): string | null {
  return /^Pkg\.Revision\s*=\s*(.+)$/m.exec(text)?.[1]?.trim() || null
}

/**
 * zip 항목 이름들이 하나의 최상위 폴더를 공유하면 그 이름을 돌려준다.
 * platform-tools.zip 은 `platform-tools/…`, scrcpy zip 은 `scrcpy-win64-vX/…` 로 묶여 있어
 * 이 폴더를 걷어 내고 풀면 실행 파일 자리가 버전과 무관하게 고정된다
 */
export function commonRootFolder(names: string[]): string | null {
  let root: string | null = null
  for (const raw of names) {
    const name = raw.replace(/\\/g, '/')
    const slash = name.indexOf('/')
    if (slash <= 0) return null
    const head = name.slice(0, slash)
    if (root === null) root = head
    else if (root !== head) return null
  }
  return root
}

/**
 * zip 을 대상 폴더에 푼다. 폴더 밖을 가리키는 항목(zip-slip)이나 상한 초과가 하나라도 있으면
 * 아무것도 쓰지 않고 던진다(검사를 먼저 끝낸다)
 */
export function extractToolZip(
  zip: Buffer,
  destDir: string,
  options: { stripRoot?: boolean; maxBytes?: number; maxEntries?: number } = {}
): void {
  const maxBytes = options.maxBytes ?? MAX_UNZIPPED_BYTES
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES
  const tooBig = (): Error =>
    new Error(`압축을 풀면 너무 커져요 (${Math.floor(maxBytes / (1024 * 1024))}MB 초과)`)

  const entries = new AdmZip(zip).getEntries()
  if (entries.length === 0) throw new Error('내려받은 압축 파일이 비어 있어요')
  if (entries.length > maxEntries)
    throw new Error(`압축 안의 파일이 너무 많아요 (${maxEntries}개 초과)`)

  const root =
    options.stripRoot === false ? null : commonRootFolder(entries.map((e) => e.entryName))
  let total = 0
  const planned: { data: () => Buffer; isDirectory: boolean; target: string }[] = []
  for (const entry of entries) {
    const name = stripRoot(entry.entryName, root)
    if (!name) continue
    if (!entry.isDirectory) {
      total += entry.header.size
      if (total > maxBytes) throw tooBig()
    }
    planned.push({
      data: () => entry.getData(),
      isDirectory: entry.isDirectory,
      target: safeToolPath(destDir, name)
    })
  }

  let written = 0
  for (const item of planned) {
    if (item.isDirectory) {
      mkdirSync(item.target, { recursive: true })
      continue
    }
    const data = item.data()
    written += data.byteLength
    if (written > maxBytes) throw tooBig()
    mkdirSync(dirname(item.target), { recursive: true })
    writeFileSync(item.target, data)
  }
}

/** 최상위 폴더 한 겹을 걷어 낸다. 폴더 자체는 빈 문자열이 되어 건너뛴다 */
function stripRoot(entryName: string, root: string | null): string {
  const name = entryName.replace(/\\/g, '/')
  if (!root) return name
  if (name === root || name === `${root}/`) return ''
  return name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name
}

/** zip-slip 검사는 확장 설치와 같은 규칙을 쓰고, 문구만 폰 쪽으로 바꿔 던진다 */
function safeToolPath(destRoot: string, entryName: string): string {
  try {
    return safeEntryPath(destRoot, entryName)
  } catch {
    throw new Error(`설치 폴더 밖을 가리키는 파일이 있어요: ${entryName}`)
  }
}

// --- 내려받기 ---------------------------------------------------------------

function tooLarge(): Error {
  return new Error(`파일이 너무 커요 (${Math.floor(MAX_TOOL_BYTES / (1024 * 1024))}MB 초과)`)
}

async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * 진행률을 알리며 내려받는다. 누적 크기가 상한을 넘으면 그 자리에서 연결을 끊는다 —
 * 통째로 메모리에 올린 뒤 재면 서버가 무한정 보낼 때 그대로 따라 커진다
 */
export async function downloadWithProgress(
  url: string,
  fetchImpl: ToolsFetcher,
  onChunk: (received: number, total: number) => void,
  maxBytes: number = MAX_TOOL_BYTES,
  timeoutMs: number = TOOL_TIMEOUT_MS
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`내려받기에 실패했어요 (HTTP ${res.status})`)
    const total = Number(res.headers?.get('content-length') ?? '') || 0
    const body = res.body
    if (!body) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw tooLarge()
      onChunk(buf.length, total || buf.length)
      return buf
    }
    const iterable =
      Symbol.asyncIterator in body
        ? (body as AsyncIterable<Uint8Array>)
        : streamToIterable(body as ReadableStream<Uint8Array>)
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of iterable) {
      received += chunk.byteLength
      if (received > maxBytes) {
        controller.abort()
        throw tooLarge()
      }
      chunks.push(Buffer.from(chunk))
      onChunk(received, total)
    }
    if (received === 0) throw new Error('내려받은 파일이 비어 있어요')
    return Buffer.concat(chunks, received)
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('내려받기 시간이 초과됐어요')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// --- 설치 상태 --------------------------------------------------------------

export function readToolsManifest(root: string): ToolsManifest | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, TOOLS_MANIFEST), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const m = raw as Partial<ToolsManifest>
    return {
      adbVersion: typeof m.adbVersion === 'string' ? m.adbVersion : null,
      scrcpyVersion: typeof m.scrcpyVersion === 'string' ? m.scrcpyVersion : null,
      installedAt: typeof m.installedAt === 'number' ? m.installedAt : 0
    }
  } catch {
    return null
  }
}

export interface ToolsStatusDeps {
  root: string
  settings: PhoneToolsSettingsLike
  exists?: (p: string) => boolean
}

/**
 * 지금 쓸 수 있는 adb·scrcpy 와 버전을 돌려준다.
 * 설정 경로가 비어 있어도 앱 데이터 설치본이 있으면 설치된 것으로 본다
 */
export function phoneToolsStatus(deps: ToolsStatusDeps): PhoneToolsStatusDto {
  const exists = deps.exists ?? existsSync
  const current = deps.settings.get()
  const manifest = readToolsManifest(deps.root)
  const pick = (settingsPath: string, exe: 'adb.exe' | 'scrcpy.exe'): [string, boolean] => {
    const installed = installedToolPath(deps.root, exe)
    if (exists(installed)) return [installed, true]
    if (settingsPath && exists(settingsPath)) return [settingsPath, false]
    return ['', false]
  }
  const [adbPath, adbOurs] = pick(current.adbPath, 'adb.exe')
  const [scrcpyPath, scrcpyOurs] = pick(current.scrcpyPath, 'scrcpy.exe')
  return {
    installed: Boolean(adbPath && scrcpyPath),
    adbPath,
    scrcpyPath,
    adbVersion: adbOurs ? (manifest?.adbVersion ?? null) : null,
    scrcpyVersion: scrcpyOurs ? (manifest?.scrcpyVersion ?? null) : null
  }
}

// --- 설치 본체 --------------------------------------------------------------

/** 한 단계의 진행률을 만들어 통지한다 */
function reporter(
  deps: InstallPhoneToolsDeps,
  step: ToolInstallStep
): (phase: PhoneToolsProgressDto['phase'], received: number, total: number) => void {
  return (phase, received, total) => {
    deps.onProgress?.({
      step,
      phase,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
      receivedBytes: received,
      totalBytes: total
    })
  }
}

/** scrcpy 최신 릴리스를 묻는다. 실패하면 고정 주소로 되돌아간다 */
export async function resolveScrcpyAsset(fetchImpl: ToolsFetcher): Promise<ScrcpyAsset> {
  const fallback: ScrcpyAsset = {
    url: SCRCPY_FALLBACK_URL,
    fileName: `scrcpy-win64-${SCRCPY_FALLBACK_VERSION}.zip`,
    version: SCRCPY_FALLBACK_VERSION,
    sumsUrl: null
  }
  try {
    const res = await fetchImpl(SCRCPY_LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return fallback
    const text = res.text ? await res.text() : Buffer.from(await res.arrayBuffer()).toString('utf8')
    return pickScrcpyAsset(JSON.parse(text) as unknown) ?? fallback
  } catch {
    return fallback
  }
}

/** SHA256SUMS 를 받아 대조한다. 목록이 없거나 이 파일이 안 적혀 있으면 넘어간다 */
async function verifyScrcpy(
  zip: Buffer,
  asset: ScrcpyAsset,
  fetchImpl: ToolsFetcher
): Promise<void> {
  if (!asset.sumsUrl) return
  let expected: string | null = null
  try {
    const res = await fetchImpl(asset.sumsUrl)
    if (!res.ok) return
    const text = res.text ? await res.text() : Buffer.from(await res.arrayBuffer()).toString('utf8')
    expected = parseSha256Sums(text, asset.fileName)
  } catch {
    return
  }
  if (!expected) return
  if (sha256(zip) !== expected) {
    throw new Error('scrcpy 내려받기가 손상됐어요 (해시가 달라요). 잠시 뒤 다시 시도해 주세요')
  }
}

/**
 * adb·scrcpy 를 앱 데이터에 설치하고 설정에 경로를 저장한다.
 * 이미 설치돼 있어도 그대로 다시 받아 덮어쓴다(재설치).
 * 어느 단계에서든 실패하면 만들다 만 폴더를 지우고 사유를 담아 던진다
 */
export async function installPhoneTools(deps: InstallPhoneToolsDeps): Promise<PhoneToolsStatusDto> {
  mkdirSync(deps.root, { recursive: true })

  // 1) platform-tools(adb)
  const ptStep = reporter(deps, 'platformTools')
  const ptZip = await downloadWithProgress(PLATFORM_TOOLS_URL, deps.fetchImpl, (r, t) =>
    ptStep('download', r, t)
  )
  assertZip(ptZip, 'platform-tools')
  ptStep('extract', 0, 0)
  const ptDir = join(deps.root, 'platform-tools')
  replaceDir(ptDir, () => extractToolZip(ptZip, ptDir))
  const adbPath = installedToolPath(deps.root, 'adb.exe')
  if (!existsSync(adbPath)) {
    rmSync(ptDir, { recursive: true, force: true })
    throw new Error('내려받은 platform-tools 안에 adb.exe 가 없어요')
  }
  ptStep('done', 1, 1)

  // 2) scrcpy
  const scStep = reporter(deps, 'scrcpy')
  const asset = await resolveScrcpyAsset(deps.fetchImpl)
  const scZip = await downloadWithProgress(asset.url, deps.fetchImpl, (r, t) =>
    scStep('download', r, t)
  )
  assertZip(scZip, 'scrcpy')
  await verifyScrcpy(scZip, asset, deps.fetchImpl)
  scStep('extract', 0, 0)
  const scDir = join(deps.root, 'scrcpy')
  replaceDir(scDir, () => extractToolZip(scZip, scDir))
  const scrcpyPath = installedToolPath(deps.root, 'scrcpy.exe')
  if (!existsSync(scrcpyPath)) {
    rmSync(scDir, { recursive: true, force: true })
    throw new Error('내려받은 scrcpy 안에 scrcpy.exe 가 없어요')
  }
  scStep('done', 1, 1)

  // 3) 버전 기록과 설정 저장 — 사용자가 경로를 적을 필요가 없어진다
  const manifest: ToolsManifest = {
    adbVersion: readPkgRevision(ptDir),
    scrcpyVersion: asset.version || null,
    installedAt: Date.now()
  }
  writeFileSync(join(deps.root, TOOLS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  deps.settings.set({ adbPath, scrcpyPath })

  return {
    installed: true,
    adbPath,
    scrcpyPath,
    adbVersion: manifest.adbVersion,
    scrcpyVersion: manifest.scrcpyVersion
  }
}

function readPkgRevision(dir: string): string | null {
  try {
    return parsePkgRevision(readFileSync(join(dir, 'source.properties'), 'utf8'))
  } catch {
    return null
  }
}

/** 기존 폴더를 비우고 다시 푼다. 푸는 중에 실패하면 반쯤 남은 폴더를 지운다 */
function replaceDir(dir: string, write: () => void): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    write()
  } catch (e: unknown) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
