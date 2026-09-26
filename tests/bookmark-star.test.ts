// 주소창 별 버튼 — 트리에서 같은 주소 찾기·북마크바 폴더 고르기
import { describe, it, expect } from 'vitest'
import { findBookmarkId, isBookmarkableUrl, toolbarFolderId } from '../src/renderer/src/components/browser/BookmarkStar'

const tree = {
  links: [{ id: 1, title: 'a', url: 'https://a.com/' }],
  folders: [
    { id: 10, name: '북마크바', isToolbar: true, links: [{ id: 2, title: 'b', url: 'https://b.com/' }], folders: [
      { id: 11, name: '쇼핑', isToolbar: false, links: [{ id: 3, title: 'c', url: 'https://c.com/x' }], folders: [] }
    ] }
  ]
}

describe('주소창 북마크 별', () => {
  it('최상위·폴더·하위 폴더에서 같은 주소를 찾는다', () => {
    expect(findBookmarkId(tree, 'https://a.com/')).toBe(1)
    expect(findBookmarkId(tree, 'https://b.com/')).toBe(2)
    expect(findBookmarkId(tree, 'https://c.com/x')).toBe(3)
    expect(findBookmarkId(tree, 'https://none.com/')).toBeNull()
  })
  it('새 북마크는 북마크바 폴더에, 없으면 최상위', () => {
    expect(toolbarFolderId(tree)).toBe(10)
    expect(toolbarFolderId({ links: [], folders: [] })).toBeNull()
  })
  it('웹 주소만 북마크한다', () => {
    expect(isBookmarkableUrl('https://x.com')).toBe(true)
    expect(isBookmarkableUrl('samba://newtab')).toBe(false)
    expect(isBookmarkableUrl(undefined)).toBe(false)
  })
})
