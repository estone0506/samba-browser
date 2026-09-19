import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_SOURCES,
  collectImportSources,
  copyExtensionFolder,
  isImportableManifest,
  listProfileDirs,
  messageKeyOf,
  pickIconPath,
  pickLatestVersionDir,
  readIconDataUrl,
  resolveExtensionName,
  scanBrowser,
  scanExtensionsDir,
  userDataDirOf
} from '../src/main/extensions/import-sources'

let tmp = ''

/** 크로미움 프로필 구조(<User Data>/<profile>/Extensions/<id>/<version>) 를 흉내낸다 */
function makeExtension(
  userDataDir: string,
  profile: string,
  id: string,
  version: string,
  manifest: Record<string, unknown>,
  extras: { locales?: Record<string, Record<string, { message: string }>>; icon?: Buffer } = {}
): string {
  const dir = join(userDataDir, profile, 'Extensions', id, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  for (const [locale, messages] of Object.entries(extras.locales ?? {})) {
    const localeDir = join(dir, '_locales', locale)
    mkdirSync(localeDir, { recursive: true })
    writeFileSync(join(localeDir, 'messages.json'), JSON.stringify(messages), 'utf8')
  }
  if (extras.icon) writeFileSync(join(dir, 'icon.png'), extras.icon)
  return dir
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'samba-import-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('브라우저 프로필 경로', () => {
  it('브라우저별 User Data 경로를 만든다', () => {
    const chrome = BROWSER_SOURCES.find((b) => b.key === 'chrome')!
    expect(userDataDirOf(chrome, 'C:\\LocalAppData')).toBe(
      join('C:\\LocalAppData', 'Google', 'Chrome', 'User Data')
    )
    const whale = BROWSER_SOURCES.find((b) => b.key === 'whale')!
    expect(userDataDirOf(whale, 'L')).toContain(join('Naver', 'Naver Whale', 'User Data'))
    const edge = BROWSER_SOURCES.find((b) => b.key === 'edge')!
    expect(userDataDirOf(edge, 'L')).toContain(join('Microsoft', 'Edge', 'User Data'))
  })

  it('Default·Profile N 만 프로필로 본다', () => {
    const userData = join(tmp, 'User Data')
    makeExtension(userData, 'Default', 'a'.repeat(32), '1.0_0', {
      name: 'a',
      version: '1.0',
      manifest_version: 3
    })
    makeExtension(userData, 'Profile 2', 'b'.repeat(32), '1.0_0', {
      name: 'b',
      version: '1.0',
      manifest_version: 3
    })
    mkdirSync(join(userData, 'System Profile', 'Extensions'), { recursive: true })
    mkdirSync(join(userData, 'Crashpad'), { recursive: true })
    expect(listProfileDirs(userData).sort()).toEqual(['Default', 'Profile 2'])
  })
})

describe('버전 폴더 고르기', () => {
  it('숫자 순서로 가장 최신을 고른다', () => {
    expect(pickLatestVersionDir(['1.9.0_0', '1.10.0_0', '1.2.0_0'])).toBe('1.10.0_0')
  })
  it('언더바로 시작하는 보조 폴더는 무시한다', () => {
    expect(pickLatestVersionDir(['_metadata'])).toBeNull()
  })
  it('비어 있으면 null', () => {
    expect(pickLatestVersionDir([])).toBeNull()
  })
})

describe('가져오기 대상 판별', () => {
  const id = 'c'.repeat(32)
  it('MV2·MV3 확장을 받는다', () => {
    expect(isImportableManifest(id, { name: 'a', version: '1', manifest_version: 3 })).toBe(true)
    expect(isImportableManifest(id, { name: 'a', version: '1', manifest_version: 2 })).toBe(true)
  })
  it('테마는 거른다', () => {
    expect(
      isImportableManifest(id, {
        name: 'a',
        version: '1',
        manifest_version: 3,
        theme: { colors: {} }
      })
    ).toBe(false)
  })
  it('브라우저 내장(컴포넌트) 확장은 거른다', () => {
    // Chrome Web Store 확장
    expect(
      isImportableManifest('ahfgeienlihckogmohjhadlkjgocpleb', {
        name: 'Web Store',
        version: '1',
        manifest_version: 3
      })
    ).toBe(false)
  })
  it('manifest_version 이 없거나 1 이면 거른다', () => {
    expect(isImportableManifest(id, { name: 'a', version: '1', manifest_version: 1 })).toBe(false)
    expect(isImportableManifest(id, { name: 'a', version: '1' })).toBe(false)
  })
})

describe('__MSG_ 이름 해석', () => {
  it('메시지 키를 알아본다', () => {
    expect(messageKeyOf('__MSG_appName__')).toBe('appName')
    expect(messageKeyOf('그냥 이름')).toBeNull()
  })

  it('default_locale 의 messages.json 에서 이름을 찾는다', () => {
    const userData = join(tmp, 'User Data')
    const dir = makeExtension(
      userData,
      'Default',
      'd'.repeat(32),
      '1.0_0',
      { name: '__MSG_appName__', version: '1.0', manifest_version: 3, default_locale: 'ko' },
      { locales: { ko: { appName: { message: '광고 차단기' } } } }
    )
    expect(resolveExtensionName('__MSG_appName__', dir, 'ko')).toBe('광고 차단기')
  })

  it('default_locale 이 없으면 en 을 본다', () => {
    const userData = join(tmp, 'User Data')
    const dir = makeExtension(
      userData,
      'Default',
      'e'.repeat(32),
      '1.0_0',
      { name: '__MSG_extName__', version: '1.0', manifest_version: 3 },
      { locales: { en: { extName: { message: 'Ad Blocker' } } } }
    )
    expect(resolveExtensionName('__MSG_extName__', dir)).toBe('Ad Blocker')
  })

  it('메시지를 못 찾으면 원문을 그대로 돌려준다', () => {
    const userData = join(tmp, 'User Data')
    const dir = makeExtension(userData, 'Default', 'f'.repeat(32), '1.0_0', {
      name: '__MSG_missing__',
      version: '1.0',
      manifest_version: 3
    })
    expect(resolveExtensionName('__MSG_missing__', dir, 'ko')).toBe('__MSG_missing__')
  })
})

describe('아이콘', () => {
  it('가장 큰 크기를 고른다', () => {
    expect(pickIconPath({ '16': 'a.png', '128': 'b.png', '48': 'c.png' })).toBe('b.png')
    expect(pickIconPath(undefined)).toBeNull()
  })

  it('확장 폴더 밖을 가리키는 아이콘은 읽지 않는다', () => {
    const userData = join(tmp, 'User Data')
    const dir = makeExtension(userData, 'Default', 'g'.repeat(32), '1.0_0', {
      name: 'a',
      version: '1',
      manifest_version: 3
    })
    expect(readIconDataUrl(dir, '../../secret.png')).toBeUndefined()
  })

  it('png 를 data URL 로 읽는다', () => {
    const userData = join(tmp, 'User Data')
    const dir = makeExtension(
      userData,
      'Default',
      'h'.repeat(32),
      '1.0_0',
      { name: 'a', version: '1', manifest_version: 3, icons: { '48': 'icon.png' } },
      { icon: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    )
    expect(readIconDataUrl(dir, 'icon.png')).toBe('data:image/png;base64,iVBORw==')
  })
})

describe('프로필 스캔', () => {
  it('확장 목록을 이름·버전·경로와 함께 돌려준다', () => {
    const userData = join(tmp, 'User Data')
    const id = 'i'.repeat(32)
    makeExtension(
      userData,
      'Default',
      id,
      '1.2.0_0',
      {
        name: '__MSG_appName__',
        version: '1.2.0',
        manifest_version: 3,
        default_locale: 'ko',
        icons: { '48': 'icon.png' }
      },
      { locales: { ko: { appName: { message: '테스트 확장' } } }, icon: Buffer.from([1, 2, 3]) }
    )
    // 테마 한 개는 목록에 나오면 안 된다
    makeExtension(userData, 'Default', 'j'.repeat(32), '1.0_0', {
      name: '테마',
      version: '1.0',
      manifest_version: 3,
      theme: {}
    })
    const items = scanExtensionsDir(join(userData, 'Default', 'Extensions'), 'chrome')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id,
      name: '테스트 확장',
      version: '1.2.0',
      browser: 'chrome',
      path: join(userData, 'Default', 'Extensions', id, '1.2.0_0')
    })
    expect(items[0].icon).toMatch(/^data:image\/png;base64,/)
  })

  it('여러 프로필에 같은 확장이 있어도 한 번만 나온다', () => {
    const userData = join(tmp, 'User Data')
    const id = 'k'.repeat(32)
    const manifest = { name: 'dup', version: '1.0', manifest_version: 3 }
    makeExtension(userData, 'Default', id, '1.0_0', manifest)
    makeExtension(userData, 'Profile 1', id, '1.0_0', manifest)
    expect(scanBrowser(userData, 'chrome')).toHaveLength(1)
  })

  it('manifest 가 깨져 있으면 그 확장만 건너뛴다', () => {
    const userData = join(tmp, 'User Data')
    const broken = join(userData, 'Default', 'Extensions', 'l'.repeat(32), '1.0_0')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'manifest.json'), '{ 깨짐', 'utf8')
    makeExtension(userData, 'Default', 'm'.repeat(32), '1.0_0', {
      name: '정상',
      version: '1.0',
      manifest_version: 3
    })
    expect(scanBrowser(userData, 'chrome').map((x) => x.name)).toEqual(['정상'])
  })

  it('설치된 브라우저가 없으면 빈 목록', () => {
    expect(collectImportSources(join(tmp, '없는폴더'))).toEqual([])
    expect(collectImportSources('')).toEqual([])
  })

  it('크롬 폴더가 있으면 브라우저별로 묶어 돌려준다', () => {
    const chromeUserData = join(tmp, 'Google', 'Chrome', 'User Data')
    makeExtension(chromeUserData, 'Default', 'n'.repeat(32), '1.0_0', {
      name: 'Chrome 확장',
      version: '1.0',
      manifest_version: 3
    })
    const out = collectImportSources(tmp)
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('chrome')
    expect(out[0].items.map((x) => x.name)).toEqual(['Chrome 확장'])
  })
})

describe('앱 데이터로 복사', () => {
  it('_metadata 를 빼고 <root>/<id> 로 복사한다', () => {
    const userData = join(tmp, 'User Data')
    const id = 'o'.repeat(32)
    const src = makeExtension(userData, 'Default', id, '1.0_0', {
      name: 'a',
      version: '1.0',
      manifest_version: 3
    })
    mkdirSync(join(src, '_metadata'), { recursive: true })
    writeFileSync(join(src, '_metadata', 'verified_contents.json'), '{}', 'utf8')
    mkdirSync(join(src, 'js'), { recursive: true })
    writeFileSync(join(src, 'js', 'bg.js'), 'x', 'utf8')

    const root = join(tmp, 'appdata', 'extensions')
    mkdirSync(root, { recursive: true })
    const dest = copyExtensionFolder(src, root, id)

    expect(dest).toBe(join(root, id))
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
    expect(existsSync(join(dest, 'js', 'bg.js'))).toBe(true)
    expect(existsSync(join(dest, '_metadata'))).toBe(false)
  })

  it('이미 있으면 통째로 갈아 끼운다', () => {
    const userData = join(tmp, 'User Data')
    const id = 'p'.repeat(32)
    const src = makeExtension(userData, 'Default', id, '2.0_0', {
      name: 'a',
      version: '2.0',
      manifest_version: 3
    })
    const root = join(tmp, 'appdata', 'extensions')
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'stale.js'), 'old', 'utf8')

    copyExtensionFolder(src, root, id)
    expect(existsSync(join(root, id, 'stale.js'))).toBe(false)
    expect(existsSync(join(root, id, 'manifest.json'))).toBe(true)
  })

  it('없는 원본은 거부한다', () => {
    expect(() => copyExtensionFolder(join(tmp, '없음'), tmp, 'x')).toThrow()
  })
})
