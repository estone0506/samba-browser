// 다른 크로미움 브라우저(크롬·웨일·엣지·브레이브)에 설치된 확장을 찾아서 가져온다.
//
// 원본 폴더를 그대로 세션에 로드하지 않는다 — 그 브라우저가 확장을 업데이트하면
// <version> 폴더가 통째로 사라져서 다음 실행에 로드가 깨지기 때문이다.
// 그래서 고른 확장은 앱 데이터(%APPDATA%/SAMBA Browser/extensions/<id>/)로 복사한 뒤
// 그 복사본만 ExtensionManager.add 로 로드한다.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ImportBrowserDto, ImportExtensionDto } from '../../shared/extensions'

/** 가져오기를 지원하는 브라우저 한 종류 */
export interface BrowserSource {
  key: string
  name: string
  /** %LOCALAPPDATA% 아래의 User Data 폴더 상대 경로 조각 */
  segments: string[]
}

/** 지원 브라우저 — 모두 크로미움이라 프로필 구조가 같다 */
export const BROWSER_SOURCES: readonly BrowserSource[] = [
  { key: 'chrome', name: 'Chrome', segments: ['Google', 'Chrome', 'User Data'] },
  { key: 'whale', name: 'Whale', segments: ['Naver', 'Naver Whale', 'User Data'] },
  { key: 'edge', name: 'Edge', segments: ['Microsoft', 'Edge', 'User Data'] },
  { key: 'brave', name: 'Brave', segments: ['BraveSoftware', 'Brave-Browser', 'User Data'] }
]

/**
 * 브라우저가 기본으로 깔고 다니는 내장(컴포넌트) 확장 id.
 * 사용자가 설치한 것이 아니라 제거해도 의미가 없고, 우리 앱에서는 동작하지도 않는다
 */
const BUILTIN_EXTENSION_IDS = new Set([
  'ahfgeienlihckogmohjhadlkjgocpleb', // Chrome Web Store
  'ghbmnnjooekpmoecnnnilnnbdlolhkhi', // Google Docs Offline
  'nmmhkkegccagdldgiimedpiccmgmieda', // Chrome Web Store Payments
  'pkedcjkdefgpdelpbcmbmeomcjbeemfm', // Chrome Cast
  'mhjfbmdgcfjbbpaeojofohoefgiehjai', // Chrome PDF Viewer
  'neajdppkdcdipfabeoofebfddakdcjhd', // Google Network Speech
  'jmjflgjpcpepeafmmgdpfkogkghcpiha' // Edge 내장(Bing 검색 도우미)
])

/** manifest.json 에서 가져오기 판단에 쓰는 값만 뽑은 형태 */
export interface ScannedManifest {
  name?: unknown
  version?: unknown
  manifest_version?: unknown
  default_locale?: unknown
  theme?: unknown
  icons?: unknown
  update_url?: unknown
}

/** `__MSG_key__` 형태인지 확인하고 키를 돌려준다 */
export function messageKeyOf(name: string): string | null {
  const m = /^__MSG_([A-Za-z0-9_@]+)__$/.exec(name.trim())
  return m ? m[1] : null
}

/**
 * manifest 의 name 을 사람이 읽는 문자열로 바꾼다.
 * `__MSG_appName__` 이면 `_locales/<default_locale>/messages.json` 에서 찾고,
 * 없으면 en·en_US 를 차례로 본다. 끝내 못 찾으면 원래 문자열을 그대로 돌려준다
 */
export function resolveExtensionName(
  rawName: string,
  extDir: string,
  defaultLocale?: string
): string {
  const key = messageKeyOf(rawName)
  if (!key) return rawName.trim()
  const locales = [defaultLocale, 'en', 'en_US', 'ko'].filter(
    (l): l is string => typeof l === 'string' && l.length > 0
  )
  for (const locale of locales) {
    const file = join(extDir, '_locales', locale, 'messages.json')
    if (!existsSync(file)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) continue
      // 크롬은 메시지 키를 대소문자 구분 없이 찾는다
      const entries = Object.entries(parsed as Record<string, unknown>)
      const hit = entries.find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]
      if (typeof hit === 'object' && hit !== null) {
        const message = (hit as { message?: unknown }).message
        if (typeof message === 'string' && message.trim()) return message.trim()
      }
    } catch {
      // 깨진 messages.json 은 조용히 넘어간다 — 가져오기 전체를 막을 이유가 없다
    }
  }
  return rawName.trim()
}

/** 테마·내장 확장·MV1 을 걸러 낸다(가져올 수 있는 것만 true) */
export function isImportableManifest(id: string, manifest: ScannedManifest): boolean {
  if (BUILTIN_EXTENSION_IDS.has(id)) return false
  // 테마는 확장이 아니라 외형 패키지다 — 로드해도 의미가 없다
  if (manifest.theme !== undefined) return false
  const mv = manifest.manifest_version
  if (mv !== 2 && mv !== 3) return false
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return false
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) return false
  return true
}

/** icons 중 가장 큰 크기의 상대 경로를 고른다 */
export function pickIconPath(icons: unknown): string | null {
  if (typeof icons !== 'object' || icons === null) return null
  let best = -1
  let path: string | null = null
  for (const [size, value] of Object.entries(icons as Record<string, unknown>)) {
    const n = Number(size)
    if (!Number.isFinite(n) || typeof value !== 'string' || !value.trim()) continue
    if (n > best) {
      best = n
      path = value.replace(/^\/+/, '')
    }
  }
  return path
}

const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

/** 아이콘 파일을 data URL 로 읽는다. 없거나 너무 크면 undefined */
export function readIconDataUrl(extDir: string, relative: string | null): string | undefined {
  if (!relative) return undefined
  const file = join(extDir, ...relative.split(/[\\/]+/))
  // 확장 폴더 밖을 가리키는 아이콘 경로는 읽지 않는다.
  // 접두 비교는 반드시 구분자까지 포함해야 한다 — `...\ext` 옆의 `...\ext-evil` 이
  // 단순 startsWith 를 통과해 버린다
  const root = resolve(extDir)
  const target = resolve(file)
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return undefined
  }
  if (!existsSync(file)) return undefined
  const dot = file.lastIndexOf('.')
  const mime = ICON_MIME[file.slice(dot).toLowerCase()]
  if (!mime) return undefined
  try {
    const buf = readFileSync(file)
    if (buf.length > 256 * 1024) return undefined
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `1.2.3_0` 같은 버전 폴더 중 가장 최근 것(사전순 마지막)을 고른다 */
export function pickLatestVersionDir(versions: string[]): string | null {
  const usable = versions.filter((v) => !v.startsWith('_'))
  if (usable.length === 0) return null
  return [...usable].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) ?? null
}

/**
 * 프로필 한 개의 Extensions 폴더를 훑는다.
 * 구조는 `<Extensions>/<id>/<version>/manifest.json` 이다
 */
export function scanExtensionsDir(extensionsDir: string, browser: string): ImportExtensionDto[] {
  const out: ImportExtensionDto[] = []
  for (const id of safeReadDir(extensionsDir)) {
    const idDir = join(extensionsDir, id)
    if (!isDir(idDir)) continue
    const version = pickLatestVersionDir(safeReadDir(idDir).filter((v) => isDir(join(idDir, v))))
    if (!version) continue
    const extDir = join(idDir, version)
    const manifestPath = join(extDir, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: ScannedManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ScannedManifest
    } catch {
      continue
    }
    if (!isImportableManifest(id, manifest)) continue
    const defaultLocale =
      typeof manifest.default_locale === 'string' ? manifest.default_locale : undefined
    out.push({
      id,
      name: resolveExtensionName(String(manifest.name), extDir, defaultLocale),
      version: String(manifest.version).trim(),
      path: extDir,
      browser,
      icon: readIconDataUrl(extDir, pickIconPath(manifest.icons))
    })
  }
  return out
}

/** User Data 아래의 프로필 폴더 이름들(Default, Profile 1, …) */
export function listProfileDirs(userDataDir: string): string[] {
  return safeReadDir(userDataDir).filter(
    (name) =>
      (name === 'Default' || /^Profile \d+$/.test(name)) &&
      isDir(join(userDataDir, name, 'Extensions'))
  )
}

/** 브라우저 한 종류의 모든 프로필을 훑어 확장 목록을 만든다(같은 id 는 한 번만) */
export function scanBrowser(userDataDir: string, browser: string): ImportExtensionDto[] {
  const seen = new Set<string>()
  const out: ImportExtensionDto[] = []
  for (const profile of listProfileDirs(userDataDir)) {
    for (const item of scanExtensionsDir(join(userDataDir, profile, 'Extensions'), browser)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 브라우저별 User Data 폴더 경로를 만든다(윈도우: %LOCALAPPDATA% 아래) */
export function userDataDirOf(source: BrowserSource, localAppData: string): string {
  return join(localAppData, ...source.segments)
}

/**
 * 설치된 브라우저를 모두 훑어 가져오기 후보를 만든다.
 * 확장이 하나도 없는 브라우저는 목록에서 뺀다
 */
export function collectImportSources(localAppData: string): ImportBrowserDto[] {
  if (!localAppData) return []
  const out: ImportBrowserDto[] = []
  for (const source of BROWSER_SOURCES) {
    const userDataDir = userDataDirOf(source, localAppData)
    if (!isDir(userDataDir)) continue
    const items = scanBrowser(userDataDir, source.key)
    if (items.length === 0) continue
    out.push({ key: source.key, name: source.name, items })
  }
  return out
}

/**
 * 원본 확장 폴더를 앱 데이터 아래(<destRoot>/<id>)로 복사한다.
 * 이미 있으면 통째로 지우고 다시 복사한다(버전 갱신).
 * 크로미움이 남기는 `_metadata`(서명 정보)는 우리 세션에서 쓸모가 없어 빼고 복사한다
 */
export function copyExtensionFolder(srcDir: string, destRoot: string, id: string): string {
  if (!isDir(srcDir)) throw new Error('원본 확장 폴더를 찾을 수 없어요')
  const dest = join(destRoot, id)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  cpSync(srcDir, dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]+/).includes('_metadata')
  })
  if (!existsSync(join(dest, 'manifest.json'))) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error('복사한 폴더에 manifest.json 이 없어요')
  }
  return dest
}
