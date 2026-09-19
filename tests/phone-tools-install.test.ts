// 폰 연동 프로그램 원클릭 설치 테스트. 실제 내려받기는 하지 않는다 —
// fetch 를 가짜로 넣고 zip 은 여기서 만들어 임시 폴더에 푼다

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLATFORM_TOOLS_URL,
  SCRCPY_FALLBACK_URL,
  SCRCPY_LATEST_API,
  TOOLS_MANIFEST,
  commonRootFolder,
  downloadWithProgress,
  extractToolZip,
  installPhoneTools,
  parsePkgRevision,
  parseSha256Sums,
  phoneToolsStatus,
  isAllowedToolUrl,
  pickScrcpyAsset,
  type ToolsFetcher,
  type ToolsResponse
} from '../src/main/phone/tools-install'
import {
  ADB_CANDIDATES,
  SCRCPY_CANDIDATES,
  detectAdbPath,
  toolCandidates
} from '../src/main/phone/adb'
import type { PhoneToolsProgressDto } from '../src/shared/phone'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'samba-phone-tools-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// --- 가짜 zip / 가짜 서버 ----------------------------------------------------

function zipOf(files: [string, string][]): Buffer {
  const zip = new AdmZip()
  for (const [name, body] of files) zip.addFile(name, Buffer.from(body, 'utf8'))
  return zip.toBuffer()
}

/**
 * 상위 폴더로 빠져나가는 항목이 든 zip.
 * adm-zip 은 항목을 넣을 때 `..` 를 정리해 버리므로, 길이가 같은 이름으로 넣고
 * 버퍼의 바이트를 직접 바꿔치기해 실제 공격 파일과 같은 모양을 만든다
 */
function slipZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('pt/xx/yy/zz.exe', Buffer.from('x', 'utf8'))
  const buf = zip.toBuffer()
  const from = Buffer.from('pt/xx/yy/zz.exe', 'utf8')
  const to = Buffer.from('pt/../../ev.exe', 'utf8')
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + from.length)) to.copy(buf, i)
  return buf
}

const PLATFORM_TOOLS_ZIP = zipOf([
  ['platform-tools/adb.exe', 'adb-binary'],
  ['platform-tools/AdbWinApi.dll', 'dll'],
  ['platform-tools/source.properties', 'Pkg.UserSrc=false\nPkg.Revision=36.0.1\n']
])

const SCRCPY_ZIP = zipOf([
  ['scrcpy-win64-v4.1/scrcpy.exe', 'scrcpy-binary'],
  ['scrcpy-win64-v4.1/scrcpy-server', 'server']
])

const SCRCPY_URL =
  'https://github.com/Genymobile/scrcpy/releases/download/v4.2/scrcpy-win64-v4.2.zip'
const SUMS_URL = 'https://github.com/Genymobile/scrcpy/releases/download/v4.2/SHA256SUMS'

function release(): string {
  return JSON.stringify({
    tag_name: 'v4.2',
    assets: [
      { name: 'scrcpy-win64-v4.2.zip', browser_download_url: SCRCPY_URL },
      { name: 'SHA256SUMS', browser_download_url: SUMS_URL },
      { name: 'scrcpy-linux-v4.2.tar.gz', browser_download_url: 'https://x/linux' }
    ]
  })
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function bytes(buf: Buffer): ToolsResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    // 두 조각으로 나눠 보내 진행률 통지가 여러 번 오게 한다
    body: (async function* () {
      yield new Uint8Array(buf.subarray(0, Math.ceil(buf.length / 2)))
      yield new Uint8Array(buf.subarray(Math.ceil(buf.length / 2)))
    })(),
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(0) as ArrayBuffer)
  }
}

function text(body: string): ToolsResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: () => Promise.resolve(Buffer.from(body, 'utf8').buffer as ArrayBuffer),
    text: () => Promise.resolve(body)
  }
}

interface FakeServer {
  fetchImpl: ToolsFetcher
  urls: string[]
}

function server(over: Partial<Record<string, () => ToolsResponse>> = {}): FakeServer {
  const scrcpyZip = SCRCPY_ZIP
  const table: Record<string, () => ToolsResponse> = {
    [PLATFORM_TOOLS_URL]: () => bytes(PLATFORM_TOOLS_ZIP),
    [SCRCPY_LATEST_API]: () => text(release()),
    [SCRCPY_URL]: () => bytes(scrcpyZip),
    [SUMS_URL]: () => text(`${sha(scrcpyZip)}  scrcpy-win64-v4.2.zip\n`),
    ...over
  }
  const urls: string[] = []
  return {
    urls,
    fetchImpl: (url) => {
      urls.push(url)
      const hit = table[url]
      if (!hit) return Promise.resolve({ ok: false, status: 404, arrayBuffer: notCalled })
      return Promise.resolve(hit())
    }
  }
}

function notCalled(): Promise<ArrayBuffer> {
  throw new Error('부르면 안 되는 경로')
}

function fakeSettings(): {
  get: () => { adbPath: string; scrcpyPath: string }
  set: (p: { adbPath?: string; scrcpyPath?: string }) => unknown
} {
  let value = { adbPath: '', scrcpyPath: '' }
  return {
    get: () => value,
    set: (p) => {
      value = { ...value, ...p }
      return value
    }
  }
}

// --- 릴리스 고르기 ----------------------------------------------------------

describe('pickScrcpyAsset', () => {
  it('win64 zip 자산과 태그·SHA256SUMS 주소를 뽑는다', () => {
    const asset = pickScrcpyAsset(JSON.parse(release()) as unknown)
    expect(asset).toEqual({
      url: SCRCPY_URL,
      fileName: 'scrcpy-win64-v4.2.zip',
      version: 'v4.2',
      sumsUrl: SUMS_URL,
      expectedSha256: null
    })
  })

  it('해시 목록 이름이 SHA256SUMS.txt 여도 찾는다(v4.1 릴리스가 그렇다)', () => {
    const txtUrl = 'https://github.com/Genymobile/scrcpy/releases/download/v4.2/SHA256SUMS.txt'
    const asset = pickScrcpyAsset({
      tag_name: 'v4.2',
      assets: [
        { name: 'scrcpy-win64-v4.2.zip', browser_download_url: SCRCPY_URL },
        { name: 'SHA256SUMS.txt', browser_download_url: txtUrl }
      ]
    })
    expect(asset?.sumsUrl).toBe(txtUrl)
  })

  it('허용 호스트가 아닌 주소는 쓰지 않는다(릴리스 JSON 은 바깥 값이다)', () => {
    expect(
      pickScrcpyAsset({
        tag_name: 'v4.2',
        assets: [
          { name: 'scrcpy-win64-v4.2.zip', browser_download_url: 'https://evil.example/x.zip' }
        ]
      })
    ).toBeNull()
    // zip 은 정상이지만 해시 목록만 딴 데면 목록을 버린다(→ 고정판으로 되돌아간다)
    const asset = pickScrcpyAsset({
      tag_name: 'v4.2',
      assets: [
        { name: 'scrcpy-win64-v4.2.zip', browser_download_url: SCRCPY_URL },
        { name: 'SHA256SUMS', browser_download_url: 'http://github.com/x/SHA256SUMS' }
      ]
    })
    expect(asset?.sumsUrl).toBeNull()
  })

  it('isAllowedToolUrl 은 https + 허용 호스트만 통과시킨다', () => {
    expect(isAllowedToolUrl(PLATFORM_TOOLS_URL)).toBe(true)
    expect(isAllowedToolUrl(SCRCPY_FALLBACK_URL)).toBe(true)
    expect(isAllowedToolUrl('http://github.com/a.zip')).toBe(false)
    expect(isAllowedToolUrl('https://evil.example/a.zip')).toBe(false)
    expect(isAllowedToolUrl('file:///C:/a.zip')).toBe(false)
    expect(isAllowedToolUrl('not a url')).toBe(false)
  })

  it('win64 zip 이 없거나 모양이 다르면 null', () => {
    expect(
      pickScrcpyAsset({ tag_name: 'v4.2', assets: [{ name: 'scrcpy-linux.tar.gz' }] })
    ).toBeNull()
    expect(pickScrcpyAsset(null)).toBeNull()
    expect(pickScrcpyAsset('nope')).toBeNull()
  })
})

describe('parseSha256Sums · parsePkgRevision', () => {
  it('파일 이름이 같은 줄의 해시만 돌려준다', () => {
    const sums = 'aa\n' + `${'1'.repeat(64)}  scrcpy-win64-v4.2.zip\n${'2'.repeat(64)} *other.zip\n`
    expect(parseSha256Sums(sums, 'scrcpy-win64-v4.2.zip')).toBe('1'.repeat(64))
    expect(parseSha256Sums(sums, 'other.zip')).toBe('2'.repeat(64))
    expect(parseSha256Sums(sums, 'none.zip')).toBeNull()
  })

  it('source.properties 에서 개정 번호를 읽는다', () => {
    expect(parsePkgRevision('Pkg.UserSrc=false\nPkg.Revision=36.0.1\n')).toBe('36.0.1')
    expect(parsePkgRevision('Pkg.UserSrc=false\n')).toBeNull()
  })
})

// --- 압축 풀기 --------------------------------------------------------------

describe('extractToolZip', () => {
  it('공통 최상위 폴더 한 겹을 걷어 내고 푼다', () => {
    const dest = join(root, 'platform-tools')
    extractToolZip(PLATFORM_TOOLS_ZIP, dest)
    expect(existsSync(join(dest, 'adb.exe'))).toBe(true)
    expect(existsSync(join(dest, 'platform-tools'))).toBe(false)
  })

  it('폴더 밖을 가리키는 항목(zip-slip)은 통째로 거부한다', () => {
    const dest = join(root, 'slip')
    expect(() => extractToolZip(slipZip(), dest)).toThrow(/폴더 밖/)
    expect(existsSync(join(root, 'ev.exe'))).toBe(false)
    expect(existsSync(join(dest, 'ev.exe'))).toBe(false)
  })

  it('절대 경로 항목도 거부한다', () => {
    const evil = zipOf([['pt/a.txt', 'a']])
    // 최상위 폴더를 걷어 낸 뒤에도 드라이브 문자가 남는 이름
    const abs = zipOf([['pt/C:/evil.exe', 'x']])
    expect(() => extractToolZip(evil, join(root, 'ok'))).not.toThrow()
    expect(() => extractToolZip(abs, join(root, 'abs'))).toThrow(/폴더 밖/)
  })

  it('해제 총량 상한을 넘으면 아무것도 쓰지 않는다', () => {
    const dest = join(root, 'big')
    expect(() => extractToolZip(PLATFORM_TOOLS_ZIP, dest, { maxBytes: 4 })).toThrow(/너무 커져요/)
    expect(existsSync(join(dest, 'adb.exe'))).toBe(false)
  })

  it('commonRootFolder 는 폴더가 갈리면 null 이다', () => {
    expect(commonRootFolder(['a/x', 'a/y/z'])).toBe('a')
    expect(commonRootFolder(['a/x', 'b/y'])).toBeNull()
    expect(commonRootFolder(['x'])).toBeNull()
  })
})

// --- 설치 본체 --------------------------------------------------------------

describe('installPhoneTools', () => {
  it('둘 다 받아 풀고 설정에 경로를 저장한다', async () => {
    const settings = fakeSettings()
    const progress: PhoneToolsProgressDto[] = []
    const status = await installPhoneTools({
      root,
      fetchImpl: server().fetchImpl,
      settings,
      onProgress: (p) => progress.push(p)
    })

    const adbPath = join(root, 'platform-tools', 'adb.exe')
    const scrcpyPath = join(root, 'scrcpy', 'scrcpy.exe')
    expect(existsSync(adbPath)).toBe(true)
    expect(existsSync(scrcpyPath)).toBe(true)
    expect(status).toEqual({
      installed: true,
      adbPath,
      scrcpyPath,
      adbVersion: '36.0.1',
      scrcpyVersion: 'v4.2'
    })
    expect(settings.get()).toEqual({ adbPath, scrcpyPath })
    // 설치 기록에 버전이 남아 재실행 없이 화면에 표시된다
    expect(JSON.parse(readFileSync(join(root, TOOLS_MANIFEST), 'utf8')) as unknown).toMatchObject({
      adbVersion: '36.0.1',
      scrcpyVersion: 'v4.2'
    })
    // 진행률은 두 단계 모두 오고 마지막은 done 이다
    expect(progress.some((p) => p.step === 'platformTools' && p.phase === 'download')).toBe(true)
    expect(progress.filter((p) => p.phase === 'download').some((p) => p.percent === 100)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ step: 'scrcpy', phase: 'done' })
  })

  it('릴리스 API 가 실패하면 고정 주소를 받되 박아 둔 해시와 대조한다', async () => {
    const s = server({
      [SCRCPY_LATEST_API]: () => ({ ok: false, status: 403, arrayBuffer: notCalled }),
      [SCRCPY_FALLBACK_URL]: () => bytes(SCRCPY_ZIP)
    })
    // 시험용 zip 은 고정판이 아니므로 해시가 어긋나 설치가 멈춘다
    await expect(
      installPhoneTools({ root, fetchImpl: s.fetchImpl, settings: fakeSettings() })
    ).rejects.toThrow(/해시가 달라요/)
    expect(s.urls).toContain(SCRCPY_FALLBACK_URL)
    expect(existsSync(join(root, 'scrcpy', 'scrcpy.exe'))).toBe(false)
  })

  it('해시 목록이 없는 릴리스는 쓰지 않고 고정판으로 되돌아간다', async () => {
    const s = server({
      [SCRCPY_LATEST_API]: () =>
        text(
          JSON.stringify({
            tag_name: 'v9.9',
            assets: [
              {
                name: 'scrcpy-win64-v9.9.zip',
                browser_download_url:
                  'https://github.com/Genymobile/scrcpy/releases/download/v9.9/scrcpy-win64-v9.9.zip'
              }
            ]
          })
        ),
      [SCRCPY_FALLBACK_URL]: () => bytes(SCRCPY_ZIP)
    })
    await expect(
      installPhoneTools({ root, fetchImpl: s.fetchImpl, settings: fakeSettings() })
    ).rejects.toThrow(/해시가 달라요/)
    expect(s.urls).toContain(SCRCPY_FALLBACK_URL)
  })

  it('해시 목록을 받지 못하면 조용히 넘어가지 않고 멈춘다', async () => {
    const settings = fakeSettings()
    const s = server({ [SUMS_URL]: () => ({ ok: false, status: 500, arrayBuffer: notCalled }) })
    await expect(installPhoneTools({ root, fetchImpl: s.fetchImpl, settings })).rejects.toThrow(
      /해시 목록을 받지 못해/
    )
    expect(settings.get().scrcpyPath).toBe('')
  })

  it('해시 목록에 이 파일이 없으면 멈춘다', async () => {
    const settings = fakeSettings()
    const s = server({
      [SUMS_URL]: () =>
        text(`${'a'.repeat(64)}  scrcpy-linux-v4.2.tar.gz
`)
    })
    await expect(installPhoneTools({ root, fetchImpl: s.fetchImpl, settings })).rejects.toThrow(
      /해시 목록에 이 파일이 없어/
    )
    expect(settings.get().scrcpyPath).toBe('')
  })

  it('허용되지 않은 주소는 내려받지 않는다', async () => {
    await expect(
      downloadWithProgress('https://evil.example/tools.zip', notCalled as never, () => undefined)
    ).rejects.toThrow(/허용되지 않은 내려받기 주소/)
  })

  it('SHA256SUMS 와 다르면 설치하지 않는다', async () => {
    const settings = fakeSettings()
    const s = server({ [SUMS_URL]: () => text(`${'9'.repeat(64)}  scrcpy-win64-v4.2.zip\n`) })
    await expect(installPhoneTools({ root, fetchImpl: s.fetchImpl, settings })).rejects.toThrow(
      /해시가 달라요/
    )
    expect(existsSync(join(root, 'scrcpy', 'scrcpy.exe'))).toBe(false)
    expect(settings.get().scrcpyPath).toBe('')
  })

  it('zip 이 아닌 응답(오류 페이지)은 풀지 않는다', async () => {
    const settings = fakeSettings()
    const s = server({ [PLATFORM_TOOLS_URL]: () => bytes(Buffer.from('<html>error</html>')) })
    await expect(installPhoneTools({ root, fetchImpl: s.fetchImpl, settings })).rejects.toThrow(
      /zip 파일이 아니에요/
    )
    expect(settings.get().adbPath).toBe('')
  })

  it('내려받기 상한을 넘으면 받다가 끊는다', async () => {
    const s = server()
    await expect(
      downloadWithProgress(PLATFORM_TOOLS_URL, s.fetchImpl, () => {}, 8)
    ).rejects.toThrow(/너무 커요/)
  })
})

// --- 상태 · 탐지 순서 --------------------------------------------------------

describe('phoneToolsStatus', () => {
  it('설치 전에는 미설치로 본다', () => {
    const status = phoneToolsStatus({ root, settings: fakeSettings() })
    expect(status.installed).toBe(false)
    expect(status.adbVersion).toBeNull()
  })

  it('설치 뒤에는 경로와 버전을 돌려준다', async () => {
    const settings = fakeSettings()
    await installPhoneTools({ root, fetchImpl: server().fetchImpl, settings })
    const status = phoneToolsStatus({ root, settings })
    expect(status.installed).toBe(true)
    expect(status.adbVersion).toBe('36.0.1')
    expect(status.scrcpyVersion).toBe('v4.2')
  })

  it('사용자가 직접 적은 경로는 버전 없이 설치됨으로 본다', () => {
    const settings = fakeSettings()
    settings.set({ adbPath: 'D:\\tools\\adb.exe', scrcpyPath: 'D:\\tools\\scrcpy.exe' })
    const status = phoneToolsStatus({
      root,
      settings,
      exists: (p) => p.startsWith('D:\\tools')
    })
    expect(status.installed).toBe(true)
    expect(status.adbVersion).toBeNull()
  })
})

describe('toolCandidates 탐지 순서', () => {
  const lookup = {
    settingsPath: 'D:\\my\\adb.exe',
    toolsRoot: 'C:\\appdata\\phone-tools',
    pathEnv: 'C:\\bin;C:\\other'
  }

  it('설정 경로 → 앱 데이터 설치본 → PATH → 기존 후보 순이다', () => {
    const list = toolCandidates('adb.exe', lookup)
    expect(list[0]).toBe('D:\\my\\adb.exe')
    expect(list[1]).toBe(join('C:\\appdata\\phone-tools', 'platform-tools', 'adb.exe'))
    expect(list[2]).toBe(join('C:\\bin', 'adb.exe'))
    expect(list[3]).toBe(join('C:\\other', 'adb.exe'))
    expect(list.slice(4)).toEqual(ADB_CANDIDATES)
  })

  it('앞 순위가 없으면 뒤 순위를 쓴다', () => {
    const installed = join('C:\\appdata\\phone-tools', 'platform-tools', 'adb.exe')
    const onlyInstalled = detectAdbPath(toolCandidates('adb.exe', lookup), (p) => p === installed)
    expect(onlyInstalled).toBe(installed)
    const onlyPath = detectAdbPath(
      toolCandidates('adb.exe', lookup),
      (p) => p === join('C:\\bin', 'adb.exe')
    )
    expect(onlyPath).toBe(join('C:\\bin', 'adb.exe'))
  })

  it('scrcpy 도 같은 순서를 쓴다', () => {
    const list = toolCandidates('scrcpy.exe', { toolsRoot: 'C:\\appdata\\phone-tools' })
    expect(list[0]).toBe(join('C:\\appdata\\phone-tools', 'scrcpy', 'scrcpy.exe'))
    expect(list.slice(1)).toEqual(SCRCPY_CANDIDATES)
  })

  it('후보는 환경변수로 만들어 사용자마다 달라진다', () => {
    const home = process.env.USERPROFILE ?? ''
    if (home) expect(ADB_CANDIDATES.some((c) => c.startsWith(home))).toBe(true)
  })
})
