import { describe, it, expect } from 'vitest'
import { parseNetscapeBookmarks } from '../src/main/import/bookmarks-html'

const SAMPLE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1000" PERSONAL_TOOLBAR_FOLDER="true">북마크바</H3>
    <DL><p>
        <DT><A HREF="https://a.example.com" ADD_DATE="1001" ICON="data:image/png;base64,abc">A 사이트</A>
        <DT><H3 ADD_DATE="1002">하위 폴더</H3>
        <DL><p>
            <DT><A HREF="https://b.example.com" ADD_DATE="1003">B 사이트</A>
            <DT><A HREF="javascript:alert(1)">위험한 링크</A>
        </DL><p>
        <DT><A HREF="https://a.example.com" ADD_DATE="1099">A 사이트 중복</A>
    </DL><p>
    <DT><H3 ADD_DATE="1004">다른 폴더</H3>
    <DL><p>
        <DT><A HREF="https://c.example.com" ADD_DATE="1005">C 사이트</A>
        <DT><A HREF="place:type=1">플레이스 링크</A>
    </DL><p>
</DL><p>
`

describe('parseNetscapeBookmarks', () => {
  it('2단계 중첩 폴더와 링크를 순서대로 파싱한다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)

    expect(tree.folders).toHaveLength(2)
    expect(tree.folders[0].name).toBe('북마크바')
    expect(tree.folders[1].name).toBe('다른 폴더')
  })

  it('PERSONAL_TOOLBAR_FOLDER="true" 인 폴더는 isToolbar 가 true 이다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    expect(tree.folders[0].isToolbar).toBe(true)
    expect(tree.folders[1].isToolbar).toBe(false)
  })

  it('ADD_DATE 를 숫자로 파싱한다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    expect(tree.folders[0].addDate).toBe(1000)
    expect(tree.folders[0].links[0].addDate).toBe(1001)
  })

  it('폴더/링크 순서를 유지한다 (링크 → 하위폴더 → 링크)', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    const toolbar = tree.folders[0]
    expect(toolbar.links.map((l) => l.title)).toEqual(['A 사이트', 'A 사이트 중복'])
    expect(toolbar.folders).toHaveLength(1)
    expect(toolbar.folders[0].name).toBe('하위 폴더')
  })

  it('javascript: 와 place: 스킴 링크는 건너뛴다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    const sub = tree.folders[0].folders[0]
    expect(sub.links.map((l) => l.url)).toEqual(['https://b.example.com'])

    const other = tree.folders[1]
    expect(other.links.map((l) => l.url)).toEqual(['https://c.example.com'])
  })

  it('icon 속성을 보존한다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    expect(tree.folders[0].links[0].icon).toBe('data:image/png;base64,abc')
  })

  it('dedupeUrls 옵션이 없으면 중복 URL 을 모두 유지한다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    const toolbar = tree.folders[0]
    expect(toolbar.links).toHaveLength(2)
  })

  it('dedupeUrls: true 이면 이후에 나오는 중복 URL 링크를 제거한다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML, { dedupeUrls: true })
    const toolbar = tree.folders[0]
    expect(toolbar.links.map((l) => l.title)).toEqual(['A 사이트'])
  })

  it('최상위 links 가 없는 문서는 links 가 빈 배열이다', () => {
    const tree = parseNetscapeBookmarks(SAMPLE_HTML)
    expect(tree.links).toEqual([])
  })

  it('HREF 속성값 안에 <dt>/<p> 문자열이 있어도 URL 이 손상되지 않는다', () => {
    const html = `<DL><p>
      <DT><A HREF="https://example.com/<dt>path/<p>more">링크</A>
    </DL><p>
    `
    const tree = parseNetscapeBookmarks(html)
    expect(tree.links).toHaveLength(1)
    expect(tree.links[0].url).toBe('https://example.com/<dt>path/<p>more')
  })

  it('제목의 &lt;p&gt; 엔티티는 그대로 보존된다', () => {
    const html = `<DL><p>
      <DT><A HREF="https://example.com">제목 안 &lt;p&gt; 태그</A>
    </DL><p>
    `
    const tree = parseNetscapeBookmarks(html)
    expect(tree.links[0].title).toBe('제목 안 <p> 태그')
  })
})
