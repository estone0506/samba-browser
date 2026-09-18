import { describe, it, expect } from 'vitest'
import { toolbarBookmarks, type FaviconLookup } from '../src/main/bookmarks/newtab'
import { NEW_TAB_BOOKMARK_LIMIT } from '../src/shared/newtab'
import { DEFAULT_SETTINGS, defaultTabUrl, parseSettings } from '../src/shared/settings'
import { NEW_TAB_URL } from '../src/shared/url'
import type { BookmarkLinkDto, BookmarkTreeDto } from '../src/shared/import'

function link(id: number, title: string, url: string): BookmarkLinkDto {
  return { id, title, url }
}

describe('toolbarBookmarks — 새 탭에 보여 줄 북마크', () => {
  it('북마크 바 폴더의 상위 링크만 쓴다', () => {
    const tree: BookmarkTreeDto = {
      folders: [
        {
          id: 1,
          name: '북마크 바',
          isToolbar: true,
          folders: [
            {
              id: 2,
              name: '하위',
              isToolbar: false,
              folders: [],
              links: [link(9, '하위', 'https://deep.com')]
            }
          ],
          links: [link(1, '네이버', 'https://www.naver.com')]
        }
      ],
      links: [link(2, '루트', 'https://root.com')]
    }
    expect(toolbarBookmarks(tree)).toEqual([
      { title: '네이버', url: 'https://www.naver.com', host: 'www.naver.com' }
    ])
  })

  it('최대 8개까지만 돌려준다', () => {
    const links = Array.from({ length: 12 }, (_, i) => link(i, `사이트${i}`, `https://s${i}.com`))
    const tree: BookmarkTreeDto = {
      folders: [{ id: 1, name: '바', isToolbar: true, folders: [], links }],
      links: []
    }
    expect(toolbarBookmarks(tree)).toHaveLength(NEW_TAB_BOOKMARK_LIMIT)
  })

  it('북마크 바 폴더가 없으면 루트 링크를 쓴다', () => {
    const tree: BookmarkTreeDto = { folders: [], links: [link(1, '루트', 'https://root.com')] }
    expect(toolbarBookmarks(tree).map((b) => b.url)).toEqual(['https://root.com'])
  })

  it('내부 페이지·허용되지 않는 스킴은 걸러낸다', () => {
    const tree: BookmarkTreeDto = {
      folders: [],
      links: [
        link(1, '내부', NEW_TAB_URL),
        link(2, 'JS', 'javascript:alert(1)'),
        link(3, '정상', 'https://ok.com')
      ]
    }
    expect(toolbarBookmarks(tree).map((b) => b.url)).toEqual(['https://ok.com'])
  })

  it('제목이 비면 호스트를 대신 쓴다', () => {
    const tree: BookmarkTreeDto = { folders: [], links: [link(1, '', 'https://a.example/x')] }
    expect(toolbarBookmarks(tree)[0].title).toBe('a.example')
  })
})

describe('toolbarBookmarks — 파비콘 채움', () => {
  function lookup(known: Record<string, string>): FaviconLookup & { asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      peek: (host) => known[host] ?? null,
      prefetch: (host) => {
        asked.push(host)
      }
    }
  }

  const tree: BookmarkTreeDto = {
    folders: [],
    links: [link(1, '네이버', 'https://www.naver.com'), link(2, '예시', 'https://example.com')]
  }

  it('캐시에 있는 파비콘을 dataUrl 로 채운다', () => {
    const favicons = lookup({ 'www.naver.com': 'data:image/png;base64,AAA' })
    const items = toolbarBookmarks(tree, favicons)
    expect(items[0].favicon).toBe('data:image/png;base64,AAA')
    // 캐시에 없는 것만 미리 받아 둔다
    expect(items[1].favicon).toBeUndefined()
    expect(favicons.asked).toEqual(['example.com'])
  })

  it('파비콘 서비스가 없으면 favicon 없이 그대로 돌려준다', () => {
    const items = toolbarBookmarks(tree, null)
    expect(items.every((i) => i.favicon === undefined)).toBe(true)
  })
})

describe('새 탭 기본 주소', () => {
  it('기본 홈 주소는 자체 새 탭 페이지다', () => {
    expect(DEFAULT_SETTINGS.homeUrl).toBe(NEW_TAB_URL)
    expect(defaultTabUrl(DEFAULT_SETTINGS)).toBe(NEW_TAB_URL)
  })

  it("새 탭 주소가 'blank' 면 빈 페이지를 연다", () => {
    expect(defaultTabUrl({ newTabUrl: 'blank', homeUrl: NEW_TAB_URL })).toBe('about:blank')
  })

  it('사용자가 설정한 홈 주소는 그대로 유지된다', () => {
    const s = parseSettings({ homeUrl: 'https://www.naver.com' })
    expect(s.homeUrl).toBe('https://www.naver.com')
    expect(defaultTabUrl(s)).toBe('https://www.naver.com')
  })

  it('허용되지 않는 홈 주소는 기본값(새 탭 페이지)으로 되돌린다', () => {
    expect(parseSettings({ homeUrl: 'javascript:alert(1)' }).homeUrl).toBe(NEW_TAB_URL)
    expect(parseSettings({ homeUrl: 'samba://settings' }).homeUrl).toBe(NEW_TAB_URL)
  })
})
