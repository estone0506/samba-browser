// 확장 설치 조율 — "다른 브라우저에서 가져오기"와 "웹스토어에서 설치"를 한곳에서 묶는다.
// 어느 쪽이든 결과는 앱 데이터(<extensionsRoot>/<id>)에 놓인 폴더이고, 로드는 ExtensionManager 가 한다.
// 한 항목이 실패해도 나머지는 계속 진행하고, 사유는 항목별 문자열로 돌려준다

import { mkdirSync } from 'node:fs'
import type {
  ExtensionInstallResult,
  ImportBrowserDto,
  ImportExtensionDto
} from '../../shared/extensions'
import { collectImportSources, copyExtensionFolder } from './import-sources'
import { installFromWebstore, type CrxFetcher } from './webstore'
import type { ExtensionManager } from './manager'

export interface ExtensionInstallerDeps {
  manager: ExtensionManager
  /** 복사·해제 결과가 놓이는 앱 데이터 폴더 */
  extensionsRoot: string
  /** 브라우저 프로필을 찾을 %LOCALAPPDATA% */
  localAppData: string
  /** 업데이트 서버에 알릴 크로미움 버전 */
  chromiumVersion: string
  fetchImpl: CrxFetcher
}

export interface ExtensionInstaller {
  importSources(): ImportBrowserDto[]
  importFrom(ids: string[]): Promise<ExtensionInstallResult[]>
  installWebstore(input: string): Promise<ExtensionInstallResult>
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createExtensionInstaller(deps: ExtensionInstallerDeps): ExtensionInstaller {
  /** 목록은 매번 다시 훑는다 — 사용자가 그 사이 확장을 깔았을 수 있다 */
  const sources = (): ImportExtensionDto[] =>
    collectImportSources(deps.localAppData).flatMap((b) => b.items)

  return {
    importSources: () => collectImportSources(deps.localAppData),

    async importFrom(ids: string[]): Promise<ExtensionInstallResult[]> {
      const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
      if (wanted.length === 0) return []
      const found = sources()
      mkdirSync(deps.extensionsRoot, { recursive: true })
      const results: ExtensionInstallResult[] = []
      for (const id of wanted) {
        try {
          const item = found.find((s) => s.id === id)
          if (!item) throw new Error('브라우저에서 그 확장을 더 이상 찾을 수 없어요')
          const dest = copyExtensionFolder(item.path, deps.extensionsRoot, id)
          // 같은 경로를 다시 로드하기 전에 이전 버전을 세션에서 걷어낸다
          deps.manager.removeByPath(dest)
          results.push({ id, item: await deps.manager.add(dest, 'imported') })
        } catch (e: unknown) {
          results.push({ id, error: messageOf(e) })
        }
      }
      return results
    },

    async installWebstore(input: string): Promise<ExtensionInstallResult> {
      mkdirSync(deps.extensionsRoot, { recursive: true })
      let id = typeof input === 'string' ? input.trim() : ''
      try {
        const dest = await installFromWebstore(id, {
          destRoot: deps.extensionsRoot,
          chromiumVersion: deps.chromiumVersion,
          fetchImpl: deps.fetchImpl
        })
        id = dest.split(/[\\/]+/).at(-1) ?? id
        deps.manager.removeByPath(dest)
        return { id, item: await deps.manager.add(dest, 'store') }
      } catch (e: unknown) {
        return { id, error: messageOf(e) }
      }
    }
  }
}
