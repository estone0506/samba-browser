// 내부 페이지 스킴(samba://) 을 앱이 직접 응답한다.
// 새 탭 페이지는 electron-vite 의 렌더러 다중 엔트리(src/renderer/newtab.html)로 빌드되고,
// 여기서 out/renderer 아래 파일로 서빙된다. 개발 모드에서는 vite 개발 서버로 넘긴다.

import { net, protocol } from 'electron'
import type { Session } from 'electron'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INTERNAL_SCHEME } from '../../shared/url'

// 스킴별 문서 루트(out/renderer 기준 파일명). host 이름이 곧 페이지 이름이다
const PAGES: Record<string, string> = {
  newtab: 'newtab.html'
}

/**
 * app.whenReady() **이전에** 호출해야 한다.
 * standard 로 등록해야 상대 경로 자원(/assets/*.js)과 fetch 가 정상 동작하고,
 * secure 로 등록해야 보안 컨텍스트 취급을 받아 모듈 스크립트가 로드된다
 */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INTERNAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

// 개발 모드에서는 vite 개발 서버의 같은 경로로 넘긴다
function devTarget(base: string, page: string, pathname: string): string {
  const path = pathname === '/' || pathname === '' ? `/${page}` : pathname
  return `${base.replace(/\/$/, '')}${path}`
}

// 디렉터리 밖(../ 경유)으로 빠져나가는 요청은 거부한다
function safeJoin(root: string, pathname: string): string | null {
  const target = resolve(join(root, normalize(decodeURIComponent(pathname))))
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/**
 * app.whenReady() **이후에** 호출한다.
 * rendererDir 은 빌드 결과(out/renderer) 경로, devServerUrl 은 개발 모드의 vite 주소다
 */
type Handler = (request: Request) => Promise<Response>

// 기본 세션에 등록한 핸들러. 탭은 persist:<profile> 파티션 세션을 쓰므로
// 그 세션에도 같은 핸들러를 붙여야 samba:// 가 열린다(세션별 protocol 은 서로 독립)
let installed: Handler | null = null

/** 탭 세션에 내부 스킴 핸들러를 붙인다. 같은 세션에는 1회만 */
export function attachInternalProtocol(ses: Session): void {
  if (!installed) return
  if (ses.protocol.isProtocolHandled(INTERNAL_SCHEME)) return
  ses.protocol.handle(INTERNAL_SCHEME, installed)
}

export function registerInternalProtocol(opts: {
  rendererDir: string
  devServerUrl?: string
}): void {
  const handler: Handler = async (request) => {
    const url = new URL(request.url)
    const page = PAGES[url.hostname]
    if (!page) return new Response('not found', { status: 404 })
    if (opts.devServerUrl) {
      return net.fetch(devTarget(opts.devServerUrl, page, url.pathname))
    }
    const pathname = url.pathname === '/' || url.pathname === '' ? `/${page}` : url.pathname
    const file = safeJoin(opts.rendererDir, pathname)
    if (!file) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  }
  installed = handler
  protocol.handle(INTERNAL_SCHEME, handler)
}
