// 새 탭 페이지에 보여 줄 북마크 목록을 고르는 순수 함수.
// 북마크 바 폴더(isToolbar)의 상위 링크를 최대 8개 쓰고, 그런 폴더가 없으면 루트 링크를 쓴다.

import type { BookmarkFolderDto, BookmarkTreeDto } from '../../shared/import'
import { NEW_TAB_BOOKMARK_LIMIT, type NewTabBookmarkDto } from '../../shared/newtab'
import { isAllowedExternalUrl } from '../../shared/url'

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

export function toolbarBookmarks(tree: BookmarkTreeDto): NewTabBookmarkDto[] {
  const toolbar = findToolbar(tree.folders)
  const links = toolbar && toolbar.links.length > 0 ? toolbar.links : tree.links
  return links
    .filter((l) => isAllowedExternalUrl(l.url))
    .slice(0, NEW_TAB_BOOKMARK_LIMIT)
    .map((l) => ({ title: l.title || hostOf(l.url), url: l.url, host: hostOf(l.url) }))
}
