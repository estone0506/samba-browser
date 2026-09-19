// 확장 관리 — 압축 해제된 크롬 확장 폴더만 다룬다.
// CRX 설치·웹스토어 연동은 하지 않으며, 로드한 폴더 경로는 설정(extensionPaths)에
// 기기 로컬로만 저장한다(동기화 대상 아님).
//
// 세션(파티션)마다 확장을 따로 걸어야 하므로, 이 관리자는 "호스트" 목록을 들고 있다.
// 첫 호스트는 기본 세션이고, 작업공간 전환으로 새 파티션 세션이 생기면 attachHost 로 붙인다.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Settings } from '../../shared/settings'
import type { ExtensionDto, ExtensionError, ExtensionSource } from '../../shared/extensions'

export type { ExtensionDto, ExtensionError, ExtensionSource }

/** 세션이 돌려주는 확장 정보(테스트에서 흉내내기 쉽도록 최소한만) */
export interface LoadedExtension {
  id: string
  name?: string
  version?: string
}

/** electron 세션 경계. 테스트는 이 인터페이스의 가짜 구현만 쓴다 */
export interface ExtensionHost {
  loadExtension: (path: string) => Promise<LoadedExtension>
  removeExtension: (id: string) => void
}

/** SettingsStore 중 이 관리자가 쓰는 부분만 */
export interface SettingsWriter {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
}

/** manifest.json 에서 실제로 쓰는 값만 뽑은 것 */
export interface ExtensionManifest {
  name: string
  version: string
  manifestVersion: 2 | 3
}

/** 지원하는 manifest 버전 — MV1 은 크로미움이 더 이상 읽지 않는다 */
const SUPPORTED_MANIFEST_VERSIONS = [2, 3]

/**
 * manifest.json 의 내용(파싱된 JSON)을 검증한다.
 * 잘못된 확장을 세션에 넘기기 전에 걸러 내기 위한 순수 함수다
 */
export function parseManifest(raw: unknown): ExtensionManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manifest.json 형식이 올바르지 않아요')
  }
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const version = typeof o.version === 'string' ? o.version.trim() : ''
  const manifestVersion = typeof o.manifest_version === 'number' ? o.manifest_version : 0
  if (!name) throw new Error('manifest.json 에 name 이 없어요')
  if (!version) throw new Error('manifest.json 에 version 이 없어요')
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifestVersion)) {
    throw new Error('지원하지 않는 manifest_version 이에요 (2 또는 3만 지원)')
  }
  return { name, version, manifestVersion: manifestVersion as 2 | 3 }
}

/**
 * 확장 폴더 경로를 실제 경로(realpath)로 바꾸고 안전한지 확인한다.
 *
 * ext:load 는 렌더러가 경로 문자열을 줄 수 있으므로, 사용자가 다이얼로그로 고른 경로든
 * 설정에 저장된 경로든 여기를 반드시 지난다. 확인하는 것은 세 가지다.
 * - 실제로 존재하는 디렉터리인가(.crx 파일·없는 경로 거부)
 * - 그 안에 manifest.json 이 있는가
 * - manifest.json 이 심볼릭 링크로 폴더 밖을 가리키지 않는가(링크 이탈 방지)
 *
 * 돌려주는 값은 심볼릭 링크를 모두 푼 절대 경로다 — 세션에는 이 경로만 넘긴다
 */
export function resolveExtensionFolder(folder: string): string {
  if (!folder.trim()) throw new Error('확장 폴더 경로가 비어 있어요')
  if (!existsSync(folder)) throw new Error('확장 폴더를 찾을 수 없어요')
  const resolved = realpathSync(folder)
  if (!statSync(resolved).isDirectory()) {
    throw new Error('압축 해제된 확장 폴더를 선택해 주세요 (.crx 파일은 지원하지 않아요)')
  }
  const manifestPath = join(resolved, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('폴더 안에 manifest.json 이 없어요')
  // 링크를 푼 뒤에도 폴더 안이어야 한다 — 밖을 가리키는 manifest 는 받지 않는다
  const realManifest = realpathSync(manifestPath)
  if (
    realManifest !== join(resolved, 'manifest.json') &&
    !realManifest.startsWith(resolved + sep)
  ) {
    throw new Error('manifest.json 이 확장 폴더 밖을 가리켜요')
  }
  return resolved
}

/**
 * 폴더가 실제로 존재하는 디렉터리인지, manifest.json 이 읽히는지 확인하고 내용을 돌려준다.
 * 압축 해제된 확장 폴더만 받는다(.crx 파일은 지원하지 않는다)
 */
export function readExtensionFolder(folder: string): ExtensionManifest {
  const resolved = resolveExtensionFolder(folder)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('manifest.json 을 읽을 수 없어요 (JSON 형식 오류)')
  }
  return parseManifest(raw)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * electron 세션이 제공하는 확장 API 의 최소 형태.
 * Electron 39 는 ses.extensions 아래에 있고, 구버전은 세션에 직접 달려 있다
 */
interface SessionExtensionApi {
  loadExtension: (path: string, options: { allowFileAccess: boolean }) => Promise<LoadedExtension>
  removeExtension: (id: string) => void
}

interface SessionLike {
  extensions?: SessionExtensionApi
  loadExtension?: SessionExtensionApi['loadExtension']
  removeExtension?: SessionExtensionApi['removeExtension']
}

/**
 * 실제 electron 세션을 ExtensionHost 로 감싼다.
 * 파일 접근(allowFileAccess)은 열어 주지 않는다 — 확장이 로컬 파일을 읽지 못하게 한다
 */
export function createSessionExtensionHost(session: SessionLike): ExtensionHost {
  const api: SessionExtensionApi | null = session.extensions
    ? session.extensions
    : session.loadExtension && session.removeExtension
      ? { loadExtension: session.loadExtension, removeExtension: session.removeExtension }
      : null
  if (!api) throw new Error('이 Electron 버전은 확장 로드를 지원하지 않아요')
  return {
    loadExtension: (path: string) => api.loadExtension(path, { allowFileAccess: false }),
    removeExtension: (id: string) => api.removeExtension(id)
  }
}

export class ExtensionManager {
  /** 로드에 성공한 확장. 설정에 저장되는 경로 순서와 같다 */
  private entries: ExtensionDto[] = []
  /** 확장을 걸어 둔 세션들. hosts[0] 은 생성자로 받은 기본 세션이다 */
  private hosts: ExtensionHost[] = []
  private failures: ExtensionError[] = []

  constructor(
    host: ExtensionHost,
    private readonly settings: SettingsWriter
  ) {
    this.hosts.push(host)
  }

  /** 설정에 저장된 경로·출처를 현재 목록으로 덮어쓴다 */
  private persist(): void {
    const sources: Record<string, ExtensionSource> = {}
    for (const e of this.entries) sources[e.path] = e.source
    this.settings.set({
      extensionPaths: this.entries.map((e) => e.path),
      extensionSources: sources
    })
  }

  /** 설정에 적힌 출처를 읽는다. 기록이 없으면(예전 버전에서 넣은 경로) 폴더로 본다 */
  private sourceOf(path: string): ExtensionSource {
    return this.settings.get().extensionSources[path] ?? 'folder'
  }

  /** 지금까지 쌓인 로드 실패 목록(설정 화면에 표시용) */
  errors(): ExtensionError[] {
    return [...this.failures]
  }

  list(): ExtensionDto[] {
    return [...this.entries]
  }

  /**
   * 앱 시작 시 저장된 경로를 순서대로 로드한다.
   * 한 개가 실패해도 나머지는 그대로 로드하고, 실패한 경로는 설정에서 지운다(앱 중단 금지)
   */
  async loadSaved(): Promise<ExtensionDto[]> {
    const saved = this.settings.get().extensionPaths
    this.entries = []
    this.failures = []
    const seen = new Set<string>()
    for (const path of saved) {
      if (seen.has(path)) continue
      seen.add(path)
      try {
        this.entries.push(await this.loadInto(this.hosts[0], path, this.sourceOf(path)))
      } catch (e: unknown) {
        this.failures.push({ path, error: messageOf(e) })
        console.error('확장 로드 실패', path, messageOf(e))
      }
    }
    this.persist()
    return this.list()
  }

  /** 폴더를 검증한 뒤 한 세션에 로드한다. 세션이 돌려준 이름·버전을 우선 쓴다 */
  private async loadInto(
    host: ExtensionHost,
    path: string,
    source: ExtensionSource
  ): Promise<ExtensionDto> {
    // 검증을 통과한 실제 경로만 세션에 넘기고 설정에도 그 경로를 적는다
    const resolved = resolveExtensionFolder(path)
    const manifest = readExtensionFolder(resolved)
    const loaded = await host.loadExtension(resolved)
    return {
      id: loaded.id,
      name: loaded.name?.trim() || manifest.name,
      version: loaded.version?.trim() || manifest.version,
      path: resolved,
      source
    }
  }

  /**
   * 사용자가 고른 폴더를 로드한다. 이미 있는 경로면 다시 로드하지 않고 기존 항목을 돌려준다.
   * 검증·로드 어느 쪽이든 실패하면 throw 하고 설정은 건드리지 않는다
   */
  async add(path: string, source: ExtensionSource = 'folder'): Promise<ExtensionDto> {
    // 검증·링크 해석을 먼저 한다 — 통과하지 못하면 목록도 설정도 건드리지 않는다
    const resolved = resolveExtensionFolder(path)
    const existing = this.entries.find((e) => e.path === resolved)
    if (existing) return existing
    const dto = await this.loadInto(this.hosts[0], resolved, source)
    this.entries.push(dto)
    this.persist()
    // 다른 파티션 세션에도 같은 확장을 걸어 준다(실패해도 전체를 되돌리지는 않는다)
    for (const host of this.hosts.slice(1)) {
      try {
        await host.loadExtension(dto.path)
      } catch (e: unknown) {
        this.failures.push({ path: dto.path, error: messageOf(e) })
      }
    }
    return dto
  }

  /**
   * 같은 폴더에 새 버전을 덮어쓰기 전에 쓴다(웹스토어 재설치·가져오기 갱신).
   * 목록에 없으면 아무 일도 하지 않는다
   */
  removeByPath(path: string): void {
    const target = existsSync(path) ? realpathSync(path) : path
    const entry = this.entries.find((e) => e.path === target)
    if (entry) this.remove(entry.id)
  }

  /** 목록·설정·모든 세션에서 확장을 걷어낸다 */
  remove(id: string): void {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index < 0) throw new Error('목록에 없는 확장이에요')
    this.entries.splice(index, 1)
    for (const host of this.hosts) {
      try {
        host.removeExtension(id)
      } catch (e: unknown) {
        console.error('확장 제거 실패', messageOf(e))
      }
    }
    this.persist()
  }

  /**
   * 새로 만들어진 파티션 세션에 지금 목록을 다시 로드한다(작업공간 전환).
   * 실패는 오류 목록에만 남기고 던지지 않는다 — 탭 생성이 확장 때문에 막히면 안 되기 때문이다
   */
  async attachHost(host: ExtensionHost): Promise<void> {
    this.hosts.push(host)
    for (const entry of this.entries) {
      try {
        await host.loadExtension(entry.path)
      } catch (e: unknown) {
        this.failures.push({ path: entry.path, error: messageOf(e) })
        console.error('확장 재로드 실패', entry.path, messageOf(e))
      }
    }
  }
}
