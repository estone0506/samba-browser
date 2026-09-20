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
 * 내려받기가 끝나도 되는 호스트. 업데이트 서버는 구글의 배포망으로 리다이렉트하므로
 * 최종 주소가 여기 없는 곳이면 받지 않는다(리다이렉트로 임의 호스트에서 받는 것을 막는다)
 */
export const CRX_ALLOWED_HOST_SUFFIXES = ['google.com', 'googleusercontent.com', 'gvt1.com']

/** https 이고 허용 호스트(또는 그 하위 도메인)인가 */
export function isAllowedCrxUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return CRX_ALLOWED_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`))
  } catch {
    return false
  }
}

/** 확장 id 인코딩 — 바이트의 각 니블을 a~p 로 적는다(크로미움과 같은 방식) */
function encodeCrxId(bytes: Buffer): string {
  let out = ''
  for (const b of bytes) {
    out += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0x0f))
  }
  return out
}

/** protobuf varint 하나를 읽는다 */
function readVarint(buf: Buffer, at: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  let i = at
  while (i < buf.length) {
    const byte = buf[i++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: i }
    shift += 7
    if (shift > 49) return null
  }
  return null
}

/** protobuf 메시지에서 지정한 번호의 length-delimited 필드를 찾는다 */
function findLengthField(buf: Buffer, field: number): Buffer | null {
  let at = 0
  while (at < buf.length) {
    const key = readVarint(buf, at)
    if (!key) return null
    at = key.next
    const wire = key.value & 0x07
    const no = Math.floor(key.value / 8)
    if (wire === 2) {
      const len = readVarint(buf, at)
      if (!len) return null
      const start = len.next
      const end = start + len.value
      if (end > buf.length) return null
      if (no === field) return buf.subarray(start, end)
      at = end
      continue
    }
    if (wire === 0) {
      const v = readVarint(buf, at)
      if (!v) return null
      at = v.next
      continue
    }
    if (wire === 5) {
      at += 4
      continue
    }
    if (wire === 1) {
      at += 8
      continue
    }
    return null
  }
  return null
}

/**
 * CRX3 헤더에 적힌 확장 id 를 읽는다.
 * CrxFileHeader.signed_header_data(필드 10000) 안의 SignedData.crx_id(필드 1, 16바이트)다.
 * 서명 자체는 검증하지 않지만, 요청한 id 와 받은 파일이 같은 확장인지는 이 값으로 확인한다
 */
export function parseCrxId(buffer: Buffer): string | null {
  if (buffer.length < 16) return null
  const headerLength = buffer.readUInt32LE(8)
  const end = 12 + headerLength
  if (headerLength <= 0 || end > buffer.length) return null
  const signed = findLengthField(buffer.subarray(12, end), 10000)
  if (!signed) return null
  const crxId = findLengthField(signed, 1)
  if (!crxId || crxId.length !== 16) return null
  return encodeCrxId(crxId)
}

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
 * 해제 후 총 바이트 상한 — 50MB 짜리 CRX 가 수십 GB 로 부풀 수 있다(zip bomb).
 * 웹스토어 확장은 압축을 풀어도 보통 수십 MB 다
 */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
/** 항목 수 상한 — 작은 파일 수백만 개로 디스크를 채우는 경우를 막는다 */
export const MAX_ZIP_ENTRIES = 5000

/**
 * ZIP 을 대상 폴더에 해제한다.
 * 한 항목이라도 폴더 밖을 가리키거나 상한(항목 수·해제 총량)을 넘으면
 * 아무것도 쓰지 않고 던진다(먼저 전부 검사한다)
 */
export function extractZip(
  zip: Buffer,
  destDir: string,
  limits: { maxBytes?: number; maxEntries?: number } = {}
): void {
  const maxBytes = limits.maxBytes ?? MAX_UNZIPPED_BYTES
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES
  const tooBig = (): Error =>
    new Error(`확장 압축을 풀면 너무 커져요 (${Math.floor(maxBytes / (1024 * 1024))}MB 초과)`)

  const archive = new AdmZip(zip)
  const entries = archive.getEntries()
  if (entries.length === 0) throw new Error('확장 압축 파일이 비어 있어요')
  if (entries.length > maxEntries) {
    throw new Error(`확장 안의 파일이 너무 많아요 (${maxEntries}개 초과)`)
  }
  // 1) 경로·크기 검사를 먼저 끝낸다 — 반쯤 풀린 폴더를 남기지 않기 위해서다.
  //    크기는 헤더의 원본 크기(header.size)로 재, 실제로 풀기 전에 거른다
  let total = 0
  const planned = entries.map((entry) => {
    if (!entry.isDirectory) {
      total += entry.header.size
      if (total > maxBytes) throw tooBig()
    }
    return { entry, target: safeEntryPath(destDir, entry.entryName) }
  })
  // 2) 실제로 쓴다. 헤더가 거짓말을 할 수 있으니 풀면서도 누적량을 다시 잰다
  let written = 0
  for (const { entry, target } of planned) {
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    const data = entry.getData()
    written += data.byteLength
    if (written > maxBytes) throw tooBig()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
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
    /** 리다이렉트를 따라간 최종 주소(있으면 호스트를 확인한다) */
    url?: string
    /** 스트림. 있으면 조각 단위로 읽어 상한을 넘는 즉시 끊는다 */
    body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
}

/** 상한 초과 메시지 — 스트림 경로와 통짜 경로가 같은 문구를 쓴다 */
function tooLarge(maxBytes: number): Error {
  return new Error(`확장 파일이 너무 커요 (${Math.floor(maxBytes / (1024 * 1024))}MB 초과)`)
}

/**
 * 응답 몸통을 조각 단위로 모은다. 누적 크기가 상한을 넘으면 그 자리에서 끊는다 —
 * 통째로 메모리에 올린 뒤 재는 방식은 서버가 무한정 보내면 그대로 따라 커진다.
 * 스트림을 주지 않는 구현(옛 테스트 스텁)은 arrayBuffer 로 되돌아간다
 */
async function readCapped(
  res: {
    body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null
    arrayBuffer: () => Promise<ArrayBuffer>
  },
  maxBytes: number,
  abort: () => void
): Promise<Buffer> {
  const body = res.body
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw tooLarge(maxBytes)
    return buf
  }
  // web ReadableStream 과 node 스트림(AsyncIterable) 을 모두 받는다
  const iterable =
    Symbol.asyncIterator in body
      ? (body as AsyncIterable<Uint8Array>)
      : streamToIterable(body as ReadableStream<Uint8Array>)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of iterable) {
    total += chunk.byteLength
    if (total > maxBytes) {
      // 더 받지 않는다 — 연결을 끊고 모아 둔 조각도 버린다
      abort()
      throw tooLarge(maxBytes)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
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
    // 업데이트 서버는 배포망으로 리다이렉트한다 — 최종 주소가 구글 호스트가 아니면 받지 않는다
    if (typeof res.url === 'string' && res.url && !isAllowedCrxUrl(res.url)) {
      controller.abort()
      throw new Error('허용하지 않는 주소로 연결됐어요')
    }
    const buf = await readCapped(res, maxBytes, () => controller.abort())
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
  /**
   * 기존 폴더를 지우기 직전에 부른다(I19). 호출부가 세션·목록에서 먼저 걷어내
   * "쓰고 있는 폴더를 지웠다가 나중에 걷어내는" 순서가 되지 않게 한다
   */
  onBeforeReplace?: (dest: string) => void
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
  // 받은 파일이 정말 그 확장인지 헤더의 crx_id 로 맞춰 본다
  const actualId = parseCrxId(crx)
  if (!actualId) throw new Error('CRX 헤더에서 확장 id 를 읽지 못했어요')
  if (actualId !== id) throw new Error(`요청한 확장과 다른 파일이에요 (${actualId})`)
  const zip = parseCrx3(crx)
  // 폴더를 건드리기 전에 호출부가 세션·목록에서 먼저 걷어낸다
  deps.onBeforeReplace?.(dest)
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
