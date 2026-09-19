import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionManager,
  parseManifest,
  readExtensionFolder,
  type ExtensionHost
} from '../src/main/extensions/manager'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

// SettingsStore 는 electron app 에 의존하므로 테스트에서는 최소 인터페이스만 흉내낸다
function makeSettings(patch: Partial<Settings> = {}): {
  get: () => Settings
  set: (p: Partial<Settings>) => Settings
} {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

// electron 세션 대신 쓰는 가짜 호스트. 로드된 경로를 기억하고, 지정한 경로는 실패시킨다
function makeHost(fail: (path: string) => boolean = () => false): ExtensionHost & {
  loaded: string[]
  removed: string[]
} {
  const loaded: string[] = []
  const removed: string[] = []
  return {
    loaded,
    removed,
    loadExtension: async (path: string) => {
      if (fail(path)) throw new Error('세션 로드 실패')
      loaded.push(path)
      return { id: `id-${loaded.length}`, name: '가짜 확장', version: '9.9.9' }
    },
    removeExtension: (id: string) => {
      removed.push(id)
    }
  }
}

describe('확장 manifest 검증', () => {
  it('name·version·manifest_version(3) 이 있으면 통과한다', () => {
    const m = parseManifest({ name: '테스트', version: '1.2.3', manifest_version: 3 })
    expect(m).toEqual({
      name: '테스트',
      version: '1.2.3',
      manifestVersion: 3,
      description: '',
      permissions: []
    })
  })

  it('manifest_version 2 도 허용한다', () => {
    expect(parseManifest({ name: 'a', version: '1', manifest_version: 2 }).manifestVersion).toBe(2)
  })

  it('manifest_version 1 은 거부한다', () => {
    expect(() => parseManifest({ name: 'a', version: '1', manifest_version: 1 })).toThrow()
  })

  it('name 이나 version 이 비면 거부한다', () => {
    expect(() => parseManifest({ version: '1', manifest_version: 3 })).toThrow()
    expect(() => parseManifest({ name: 'a', manifest_version: 3 })).toThrow()
  })

  it('permissions 와 host_permissions 를 합쳐 권한 요약으로 돌려준다', () => {
    const m = parseManifest({
      name: 'a',
      version: '1',
      manifest_version: 3,
      description: '  설명  ',
      permissions: ['tabs', 'storage'],
      host_permissions: ['https://example.com/*']
    })
    expect(m.permissions).toEqual(['tabs', 'storage', 'https://example.com/*'])
    expect(m.description).toBe('설명')
  })

  it('권한 형식이 틀려도 거부하지 않고 걸러 낸다(화면 표시용 값이다)', () => {
    const m = parseManifest({
      name: 'a',
      version: '1',
      manifest_version: 3,
      permissions: ['tabs', 7, null],
      host_permissions: '문자열'
    })
    expect(m.permissions).toEqual(['tabs'])
  })

  it('객체가 아니면 거부한다', () => {
    expect(() => parseManifest('문자열')).toThrow()
    expect(() => parseManifest(null)).toThrow()
  })
})

describe('ExtensionManager', () => {
  let root: string
  let settings: ReturnType<typeof makeSettings>

  // manifest.json 을 갖춘 압축 해제 확장 폴더를 만든다
  function makeFolder(name: string, manifest?: unknown): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    if (manifest !== undefined) {
      writeFileSync(dir + '/manifest.json', JSON.stringify(manifest), 'utf8')
    }
    return dir
  }

  const validManifest = (name: string): Record<string, unknown> => ({
    name,
    version: '1.0.0',
    manifest_version: 3
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'samba-ext-'))
    settings = makeSettings()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('add 성공이면 설정에 경로가 남고 목록이 1건이다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('good', validManifest('좋은 확장'))

    const dto = await mgr.add(dir)

    expect(dto.path).toBe(dir)
    expect(mgr.list()).toHaveLength(1)
    expect(settings.get().extensionPaths).toEqual([dir])
    expect(host.loaded).toEqual([dir])
  })

  it('같은 경로를 두 번 add 해도 1건만 남는다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('dup', validManifest('중복'))

    const first = await mgr.add(dir)
    const second = await mgr.add(dir)

    expect(second.id).toBe(first.id)
    expect(mgr.list()).toHaveLength(1)
    expect(settings.get().extensionPaths).toEqual([dir])
    // 두 번째 add 는 세션에 다시 로드하지 않는다
    expect(host.loaded).toHaveLength(1)
  })

  it('manifest.json 이 없으면 throw 하고 경로가 저장되지 않는다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('no-manifest')

    await expect(mgr.add(dir)).rejects.toThrow()
    expect(mgr.list()).toHaveLength(0)
    expect(settings.get().extensionPaths).toEqual([])
    expect(host.loaded).toHaveLength(0)
  })

  it('없는 경로·파일 경로는 throw 한다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const filePath = join(root, 'plain.txt')
    writeFileSync(filePath, 'x', 'utf8')

    await expect(mgr.add(join(root, '없는폴더'))).rejects.toThrow()
    await expect(mgr.add(filePath)).rejects.toThrow()
    expect(settings.get().extensionPaths).toEqual([])
  })

  it('세션 로드가 실패하면 throw 하고 경로가 저장되지 않는다', async () => {
    const dir = makeFolder('boom', validManifest('실패'))
    const host = makeHost((p) => p === dir)
    const mgr = new ExtensionManager(host, settings)

    await expect(mgr.add(dir)).rejects.toThrow()
    expect(settings.get().extensionPaths).toEqual([])
  })

  it('remove 후 목록과 설정 양쪽에서 사라진다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('remove-me', validManifest('제거 대상'))
    const dto = await mgr.add(dir)

    mgr.remove(dto.id)

    expect(mgr.list()).toHaveLength(0)
    expect(settings.get().extensionPaths).toEqual([])
    expect(host.removed).toEqual([dto.id])
  })

  it('없는 id 를 remove 하면 throw 한다', async () => {
    const mgr = new ExtensionManager(makeHost(), settings)
    expect(() => mgr.remove('없는-id')).toThrow()
  })

  it('loadSaved 는 하나가 실패해도 나머지를 로드하고 실패 경로를 설정에서 지운다', async () => {
    const ok1 = makeFolder('ok1', validManifest('하나'))
    const bad = makeFolder('bad')
    const ok2 = makeFolder('ok2', validManifest('둘'))
    settings.set({ extensionPaths: [ok1, bad, ok2] })
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)

    const list = await mgr.loadSaved()

    expect(list.map((e) => e.path)).toEqual([ok1, ok2])
    expect(settings.get().extensionPaths).toEqual([ok1, ok2])
    expect(host.loaded).toEqual([ok1, ok2])
    // 실패는 앱을 멈추지 않고 항목별 오류 문자열로 남는다
    expect(mgr.errors()).toHaveLength(1)
    expect(mgr.errors()[0].path).toBe(bad)
    expect(typeof mgr.errors()[0].error).toBe('string')
  })

  it('loadSaved 는 저장 순서를 지키고 중복 경로는 1건으로 합친다', async () => {
    const a = makeFolder('a', validManifest('에이'))
    const b = makeFolder('b', validManifest('비'))
    settings.set({ extensionPaths: [b, a, b] })
    const mgr = new ExtensionManager(makeHost(), settings)

    const list = await mgr.loadSaved()

    expect(list.map((e) => e.path)).toEqual([b, a])
    expect(settings.get().extensionPaths).toEqual([b, a])
  })

  it('attachHost 는 새 파티션 세션에 지금 목록을 다시 로드한다', async () => {
    const primary = makeHost()
    const mgr = new ExtensionManager(primary, settings)
    const dir = makeFolder('shared', validManifest('공유'))
    await mgr.add(dir)

    const second = makeHost()
    await mgr.attachHost(second)

    expect(second.loaded).toEqual([dir])

    // 새로 붙인 세션에도 이후의 add·remove 가 함께 적용된다
    const dir2 = makeFolder('shared2', validManifest('공유2'))
    const dto2 = await mgr.add(dir2)
    expect(second.loaded).toEqual([dir, dir2])
    mgr.remove(dto2.id)
    expect(second.removed).toEqual([dto2.id])
  })

  it('attachHost 의 로드 실패는 던지지 않고 오류 목록에만 남는다', async () => {
    const primary = makeHost()
    const mgr = new ExtensionManager(primary, settings)
    const dir = makeFolder('only-primary', validManifest('일부 실패'))
    await mgr.add(dir)

    await mgr.attachHost(makeHost(() => true))

    expect(mgr.list()).toHaveLength(1)
    expect(mgr.errors()).toHaveLength(1)
  })

  it('readExtensionFolder 는 폴더의 manifest.json 을 읽어 준다', () => {
    const dir = makeFolder('read', validManifest('읽기'))
    expect(readExtensionFolder(dir)).toEqual({
      name: '읽기',
      version: '1.0.0',
      manifestVersion: 3,
      description: '',
      permissions: []
    })
  })

  it('없는 경로·파일 경로는 거부한다', () => {
    expect(() => readExtensionFolder(join(root, '없는-폴더'))).toThrow()
    const file = join(root, 'not-a-folder.crx')
    writeFileSync(file, 'x', 'utf8')
    expect(() => readExtensionFolder(file)).toThrow()
  })

  it('manifest.json 이 없으면 거부한다', () => {
    expect(() => readExtensionFolder(makeFolder('no-manifest'))).toThrow()
  })

  it('manifest.json 이 폴더 밖을 가리키는 심볼릭 링크면 거부한다', () => {
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify(validManifest('밖')), 'utf8')
    const dir = makeFolder('escape')
    try {
      symlinkSync(outside, join(dir, 'manifest.json'), 'file')
    } catch {
      // Windows 는 개발자 모드·관리자 권한이 없으면 심볼릭 링크를 만들 수 없다
      return
    }
    expect(() => readExtensionFolder(dir)).toThrow('확장 폴더 밖')
  })

  it('심볼릭 링크로 준 폴더 경로는 실제 경로로 정규화해 저장한다', async () => {
    const real = makeFolder('real', validManifest('정규화'))
    const link = join(root, 'link')
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return
    }
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)

    const dto = await mgr.add(link)

    expect(dto.path).toBe(realpathSync(real))
    expect(host.loaded).toEqual([realpathSync(real)])
  })

  it('끄면 세션에서만 빠지고 목록·경로는 그대로 남는다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('toggle', validManifest('토글'))
    const dto = await mgr.add(dir)

    const off = await mgr.setEnabled(dto.id, false)

    expect(off.enabled).toBe(false)
    expect(host.removed).toEqual([dto.id])
    // 다시 켤 수 있어야 하므로 목록과 저장된 경로는 그대로다
    expect(mgr.list()).toHaveLength(1)
    expect(settings.get().extensionPaths).toEqual([dir])
    expect(settings.get().disabledExtensionIds).toEqual([dto.id])
  })

  it('다시 켜면 세션에 한 번 더 로드하고 꺼짐 목록에서 빠진다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dir = makeFolder('again', validManifest('다시'))
    const dto = await mgr.add(dir)
    await mgr.setEnabled(dto.id, false)

    const on = await mgr.setEnabled(dto.id, true)

    expect(on.enabled).toBe(true)
    expect(host.loaded).toEqual([dir, dir])
    expect(settings.get().disabledExtensionIds).toEqual([])
  })

  it('같은 상태로 다시 부르면 세션을 건드리지 않는다', async () => {
    const host = makeHost()
    const mgr = new ExtensionManager(host, settings)
    const dto = await mgr.add(makeFolder('noop', validManifest('그대로')))

    await mgr.setEnabled(dto.id, true)

    expect(host.loaded).toHaveLength(1)
    expect(host.removed).toHaveLength(0)
  })

  it('없는 id 를 켜고 끄면 throw 한다', async () => {
    const mgr = new ExtensionManager(makeHost(), settings)
    await expect(mgr.setEnabled('없는-id', false)).rejects.toThrow()
  })

  it('켜다가 실패하면 꺼진 상태 그대로 둔다', async () => {
    const dir = makeFolder('fail-on', validManifest('실패'))
    let blocked = false
    const host = makeHost(() => blocked)
    const mgr = new ExtensionManager(host, settings)
    const dto = await mgr.add(dir)
    await mgr.setEnabled(dto.id, false)

    blocked = true
    await expect(mgr.setEnabled(dto.id, true)).rejects.toThrow()

    expect(mgr.list()[0].enabled).toBe(false)
    expect(settings.get().disabledExtensionIds).toEqual([dto.id])
  })

  it('loadSaved 는 꺼 둔 확장을 목록에 남기되 세션에서는 걷어낸다', async () => {
    const on = makeFolder('on', validManifest('켜짐'))
    const off = makeFolder('off', validManifest('꺼짐'))
    settings.set({ extensionPaths: [on, off] })
    const host = makeHost()
    // 가짜 호스트는 로드 순서대로 id 를 주므로 두 번째가 id-2 다
    settings.set({ disabledExtensionIds: ['id-2'] })
    const mgr = new ExtensionManager(host, settings)

    const list = await mgr.loadSaved()

    expect(list.map((e) => e.enabled)).toEqual([true, false])
    expect(host.removed).toEqual(['id-2'])
    expect(settings.get().extensionPaths).toEqual([on, off])
  })

  it('attachHost 는 꺼 둔 확장을 새 세션에 올리지 않는다', async () => {
    const mgr = new ExtensionManager(makeHost(), settings)
    const kept = await mgr.add(makeFolder('kept', validManifest('켜짐')))
    const hidden = await mgr.add(makeFolder('hidden', validManifest('꺼짐')))
    await mgr.setEnabled(hidden.id, false)

    const second = makeHost()
    await mgr.attachHost(second)

    expect(second.loaded).toEqual([kept.path])
  })

  it('extensionPaths 는 동기화 대상이 아니다(기기 로컬 설정)', async () => {
    const mod: Record<string, unknown> = await import('../src/shared/sync')
    const keys = mod.SYNCED_SETTING_KEYS
    // 동기화 설정 키 목록이 생기기 전까지는 확인할 것이 없다
    if (!Array.isArray(keys)) {
      expect(keys).toBeUndefined()
      return
    }
    expect(keys).not.toContain('extensionPaths')
  })
})
