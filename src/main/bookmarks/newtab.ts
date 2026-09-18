// 새 탭 페이지에 보여 줄 북마크 목록을 고르는 순수 함수.
// 북마크 바 폴더(isToolbar)의 상위 링크를 최대 8개 쓰고, 그런 폴더가 없으면 루트 링크를 쓴다.

import type { BookmarkFolderDto, BookmarkTreeDto } from '../../shared/import'
import { NEW_TAB_BOOKMARK_LIMIT, type NewTabBookmarkDto } from '../../shared/newtab'
import { isAllowedExternalUrl } from '../../shared/url'
import { getFaviconService } from '../favicon/service'

// 파비콘 조회에 필요한 만큼만 좁힌 인터페이스(테스트에서 가짜를 넣기 위해 분리)
export interface FaviconLookup {
  // 동기 조회 — 캐시에 있을 때만 값이 나온다
  peek: (host: string) => string | null
  // 캐시에 없으면 다음 새 탭에서 쓰이도록 미리 받아 둔다
  prefetch: (host: string) => void
}

// 파비콘 조회용 호스트. 파싱에 실패하면 빈 문자열(페이지는 첫 글자 폴백을 그린다)
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// 북마크 바 폴더를 깊이 우선으로 찾는다(가져오기 형식에 따라 한 단계 아래에 있을 수 있다)
function findToolbar(folders: BookmarkFolderDto[]): BookmarkFolderDto | null {
  for (const f of folders) {
    if (f.isToolbar) return f
    const nested = findToolbar(f.folders)
    if (nested) return nested
  }
  return null
}

/**
 * 새 탭 북마크 목록. 파비콘은 메인 캐시(사이트 자체에서 받아 둔 것)에서만 꺼내 쓰고,
 * 없으면 미리 받아 두기만 한다 — 호출부가 동기라서 여기서 기다리지 않는다.
 */
export function toolbarBookmarks(
  tree: BookmarkTreeDto,
  favicons: FaviconLookup | null = getFaviconService()
): NewTabBookmarkDto[] {
  const toolbar = findToolbar(tree.folders)
  const links = toolbar && toolbar.links.length > 0 ? toolbar.links : tree.links
  return links
    .filter((l) => isAllowedExternalUrl(l.url))
    .slice(0, NEW_TAB_BOOKMARK_LIMIT)
    .map((l) => {
      const host = hostOf(l.url)
      const favicon = host ? favicons?.peek(host) : null
      if (host && !favicon) favicons?.prefetch(host)
      const dto: NewTabBookmarkDto = { title: l.title || host, url: l.url, host }
      if (favicon) dto.favicon = favicon
      return dto
    })
}
