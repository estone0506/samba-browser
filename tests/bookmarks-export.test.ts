import { describe, it, expect } from 'vitest'
import { parseNetscapeBookmarks } from '../src/main/import/bookmarks-html'
import { toNetscapeHtml } from '../src/main/import/bookmarks-export'

const SAMPLE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1000" PERSONAL_TOOLBAR_FOLDER="true">북마크바</H3>
    <DL><p>
        <DT><A HREF="https://a.example.com" ADD_DATE="1001">A 사이트</A>
        <DT><H3 ADD_DATE="1002">하위 폴더</H3>
        <DL><p>
            <DT><A HREF="https://b.example.com" ADD_DATE="1003">B 사이트</A>
        </DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="1004">다른 폴더</H3>
    <DL><p>
        <DT><A HREF="https://c.example.com" ADD_DATE="1005">C 사이트</A>
    </DL><p>
</DL><p>
`

describe('toNetscapeHtml', () => {
  it('파서 결과를 내보낸 뒤 다시 파싱하면 폴더/링크 구조가 동일하다 (round-trip)', () => {
    const original = parseNetscapeBookmarks(SAMPLE_HTML)
    const html = toNetscapeHtml(original)
    const reparsed = parseNetscapeBookmarks(html)

    expect(reparsed).toEqual(original)
  })

  it('북마크 바(PERSONAL_TOOLBAR_FOLDER)와 ADD_DATE 를 왕복 보존한다', () => {
    const original = parseNetscapeBookmarks(SAMPLE_HTML)
    const html = toNetscapeHtml(original)

    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true"')
    const reparsed = parseNetscapeBookmarks(html)
    expect(reparsed.folders[0].isToolbar).toBe(true)
    expect(reparsed.folders[0].addDate).toBe(1000)
    expect(reparsed.folders[0].links[0].addDate).toBe(1001)
  })

  it('제목·URL 안의 &, <, >, " 를 이스케이프하고 다시 파싱해도 원래 값이 복원된다', () => {
    const tree = {
      folders: [],
      links: [
        {
          title: 'A & B <탭> "따옴표"',
          url: 'https://example.com/?q=a&b=<c>&d="e"'
        }
      ]
    }
    const html = toNetscapeHtml(tree)
    expect(html).not.toContain('<탭>')
    const reparsed = parseNetscapeBookmarks(html)
    expect(reparsed.links[0].title).toBe(tree.links[0].title)
    expect(reparsed.links[0].url).toBe(tree.links[0].url)
  })

  it('빈 트리는 폴더/링크가 없는 최소 문서를 만든다', () => {
    const html = toNetscapeHtml({ folders: [], links: [] })
    const reparsed = parseNetscapeBookmarks(html)
    expect(reparsed.folders).toEqual([])
    expect(reparsed.links).toEqual([])
  })

  it('중첩 폴더 구조도 왕복 보존한다', () => {
    const tree = {
      folders: [
        {
          name: '부모',
          isToolbar: false,
          folders: [
            {
              name: '자식',
              isToolbar: false,
              folders: [],
              links: [{ title: '링크', url: 'https://nested.example.com' }]
            }
          ],
          links: []
        }
      ],
      links: []
    }
    const html = toNetscapeHtml(tree)
    const reparsed = parseNetscapeBookmarks(html)
    expect(reparsed.folders[0].name).toBe('부모')
    expect(reparsed.folders[0].folders[0].name).toBe('자식')
    expect(reparsed.folders[0].folders[0].links[0].url).toBe('https://nested.example.com')
  })
})
