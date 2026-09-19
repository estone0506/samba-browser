// 크롬 웹스토어에서 확장을 내려받아 설치한다.
//
// 흐름: 입력(스토어 URL 또는 32자 id) → id 추출 → 구글 업데이트 서버에서 CRX3 내려받기
// → CRX3 헤더를 걷어 내고 남은 ZIP 을 앱 데이터(<destRoot>/<id>)에 해제 → manifest 검증.
// 서명은 검증하지 않는다(크로미움처럼 공개키로 id 를 확인하지는 않는다) — 대신 요청한
// id 폴더에만 쓰고, ZIP 안의 경로가 폴더 밖을 가리키면(zip-slip) 통째로 거부한다.

import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

/** 내려받기 상한 — 웹스토어 확장은 보통 몇 MB 다 */
export const MAX_CRX_BYTES = 50 * 1024 * 1024
/** 내려받기 제한 시간 */
export const CRX_TIMEOUT_MS = 60_000

/** 확장 id 는 a–p 32자다(크로미움이 공개키 해시를 그렇게 인코딩한다) */
const EXTENSION_ID_RE = /^[a-p]{32}$/

/**
 * 사용자가 붙여 넣은 문자열에서 확장 id 를 뽑는다.
 * - `https://chromewebstore.google.com/detail/<이름>/<id>` (뒤에 `?hl=ko` 등이 붙어도 된다)
 * - 옛 주소 `https://chrome.google.com/webstore/detail/<이름>/<id>`
 * - id 만 32자로 붙여 넣은 경우
 */
export function extractExtensionId(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('확장 주소나 id 를 입력해 주세요')
  if (EXTENSION_ID_RE.test(raw)) return raw
  // 주소 안의 경로 조각 중 id 형태인 것을 찾는다(쿼리·해시는 버린다)
  const withoutQuery = raw.split(/[?#]/)[0]
  const segments = withoutQuery.split('/').filter(Boolean)
  const hit = [...segments].reverse().find((s) => EXTENSION_ID_RE.test(s))
  if (hit) return hit
  throw new Error('확장 id 를 찾지 못했어요 (웹스토어 주소나 32자 id 를 넣어 주세요)')
}

/** 구글 업데이트 서버의 CRX3 내려받기 주소를 만든다 */
export function buildCrxUrl(id: string, chromiumVersion: string): string {
  const x = encodeURIComponent(`id=${id}&uc`)
  return (
    'https://clients2.google.com/service/update2/crx' +
    `?response=redirect&prodversion=${encodeURIComponent(chromiumVersion)}` +
    `&acceptformat=crx3&x=${x}`
  )
}

/** CRX3 매직 넘버 `Cr24` */
const CRX_MAGIC = 'Cr24'

/**
 * CRX3 파일에서 ZIP 부분만 잘라 낸다.
 * 구조는 [매직 4B][버전 4B LE][헤더 길이 4B LE][헤더][ZIP] 이다.
 * CRX2(버전 2)는 헤더 구조가 달라 받지 않는다 — 웹스토어도 더 이상 내주지 않는다
 */
export function parseCrx3(buffer: Buffer): Buffer {
  if (buffer.length < 16) throw new Error('내려받은 파일이 너무 짧아요 (CRX 가 아니에요)')
  if (buffer.subarray(0, 4).toString('latin1') !== CRX_MAGIC) {
    throw new Error('CRX 파일이 아니에요 (매직 넘버가 달라요)')
  }
  const version = buffer.readUInt32LE(4)
  if (version !== 3) throw new Error(`지원하지 않는 CRX 버전이에요 (${version})`)
  const headerLength = buffer.readUInt32LE(8)
  const zipStart = 12 + headerLength
  if (headerLength <= 0 || zipStart > buffer.length) {
    throw new Error('CRX 헤더 길이가 올바르지 않아요')
  }
  const zip = buffer.subarray(zipStart)
  if (zip.length < 4 || zip.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('CRX 안에서 ZIP 을 찾지 못했어요')
  }
  return zip
}

/**
 * ZIP 항목 이름이 대상 폴더 안에 머무는지 확인한다(zip-slip 방지).
 * 절대 경로·드라이브 문자·`..` 이탈을 모두 막는다
 */
export function safeEntryPath(destRoot: string, entryName: string): string {
  const name = entryName.replace(/\\/g, '/')
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`확장 폴더 밖을 가리키는 파일이 있어요: ${entryName}`)
  }
  const root = normalize(destRoot)
  const target = normalize(join(root, name))
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`확장 폴더 밖을 가리키는 파일이 있어요: ${entryName}`)
  }
  return target
}

/**
 * ZIP 을 대상 폴더에 해제한다.
 * 한 항목이라도 폴더 밖을 가리키면 아무것도 쓰지 않고 던진다(먼저 전부 검사한다)
 */
export function extractZip(zip: Buffer, destDir: string): void {
  const archive = new AdmZip(zip)
  const entries = archive.getEntries()
  if (entries.length === 0) throw new Error('확장 압축 파일이 비어 있어요')
  // 1) 경로 검사를 먼저 끝낸다 — 반쯤 풀린 폴더를 남기지 않기 위해서다
  const planned = entries.map((entry) => ({
    entry,
    target: safeEntryPath(destDir, entry.entryName)
  }))
  // 2) 실제로 쓴다
  for (const { entry, target } of planned) {
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}

/** net.fetch 만큼의 최소 형태 — 테스트는 가짜 구현을 넣는다 */
export interface CrxFetcher {
  (
    url: string,
    init?: { signal?: AbortSignal }
  ): Promise<{
    ok: boolean
    status: number
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
}

/** CRX 를 내려받는다. 크기 상한·제한 시간을 넘기면 던진다 */
export async function downloadCrx(
  url: string,
  fetchImpl: CrxFetcher,
  maxBytes: number = MAX_CRX_BYTES,
  timeoutMs: number = CRX_TIMEOUT_MS
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`내려받기에 실패했어요 (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('확장 파일이 너무 커요 (50MB 초과)')
    if (buf.length === 0) throw new Error('내려받은 파일이 비어 있어요')
    return buf
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('내려받기 시간이 초과됐어요')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 해제한 폴더의 manifest 가 우리 세션에서 쓸 수 있는지 본다 */
export function assertInstallableManifest(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null)
    throw new Error('manifest.json 형식이 올바르지 않아요')
  const mv = (raw as { manifest_version?: unknown }).manifest_version
  if (mv === 2) throw new Error('MV2(Manifest V2) 확장은 지원하지 않아요')
  if (mv !== 3) throw new Error('지원하지 않는 manifest_version 이에요 (3만 지원)')
}

export interface InstallWebstoreDeps {
  /** 앱 데이터의 extensions 루트 */
  destRoot: string
  /** 프로덕트 버전(크로미움 버전) — 업데이트 서버가 이 값으로 호환 빌드를 고른다 */
  chromiumVersion: string
  fetchImpl: CrxFetcher
  /** manifest.json 읽기(테스트에서 바꿔 끼운다) */
  readManifest?: (dir: string) => unknown
}

/**
 * 웹스토어 확장 한 개를 내려받아 <destRoot>/<id> 에 해제한다.
 * 어느 단계에서든 실패하면 만들다 만 폴더를 지우고 사유를 담아 던진다
 */
export async function installFromWebstore(
  input: string,
  deps: InstallWebstoreDeps
): Promise<string> {
  const id = extractExtensionId(input)
  const dest = join(deps.destRoot, id)
  const crx = await downloadCrx(buildCrxUrl(id, deps.chromiumVersion), deps.fetchImpl)
  const zip = parseCrx3(crx)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  try {
    extractZip(zip, dest)
    const manifestPath = join(dest, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('확장 안에 manifest.json 이 없어요')
    const read = deps.readManifest ?? defaultReadManifest
    assertInstallableManifest(read(dest))
    return dest
  } catch (e: unknown) {
    rmSync(dest, { recursive: true, force: true })
    throw e
  }
}

function defaultReadManifest(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('manifest.json 을 읽을 수 없어요 (JSON 형식 오류)')
  }
}
