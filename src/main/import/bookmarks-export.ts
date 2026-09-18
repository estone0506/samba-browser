// 북마크 내보내기 — DB/파서 트리를 Netscape 북마크 HTML 문자열로 직렬화한다.
// 순수 함수 — Electron 의존성 없음. bookmarks-html.ts 파서로 다시 읽으면(round-trip)
// 같은 트리가 나오도록 속성 이름(HREF/ADD_DATE/PERSONAL_TOOLBAR_FOLDER)을 파서와 맞춘다.

export interface ExportLink {
  title: string
  url: string
  addDate?: number
}

export interface ExportFolder {
  name: string
  isToolbar: boolean
  addDate?: number
  folders: ExportFolder[]
  links: ExportLink[]
}

// BookmarkTreeDto(id 포함)·BookmarkTree(파서 출력) 양쪽과 구조적으로 호환된다
export interface ExportTree {
  folders: ExportFolder[]
  links: ExportLink[]
}

// 텍스트 노드(H3/A 안쪽) 이스케이프
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 속성값(따옴표로 감싼 안) 이스케이프
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function indent(depth: number): string {
  return '    '.repeat(depth)
}

function renderLink(link: ExportLink, depth: number): string {
  const addDate = link.addDate !== undefined ? ` ADD_DATE="${link.addDate}"` : ''
  return `${indent(depth)}<DT><A HREF="${escapeAttr(link.url)}"${addDate}>${escapeText(link.title)}</A>`
}

function renderFolder(folder: ExportFolder, depth: number): string {
  const addDate = folder.addDate !== undefined ? ` ADD_DATE="${folder.addDate}"` : ''
  const toolbar = folder.isToolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''
  const lines: string[] = []
  lines.push(`${indent(depth)}<DT><H3${addDate}${toolbar}>${escapeText(folder.name)}</H3>`)
  lines.push(`${indent(depth)}<DL><p>`)
  lines.push(...renderChildren(folder, depth + 1))
  lines.push(`${indent(depth)}</DL><p>`)
  return lines.join('\n')
}

// 파서(bookmarks-html.ts)가 문서 순서를 그대로 보존하는 것과 대칭으로, 링크를 먼저 쓰고
// 그 다음 하위 폴더를 쓴다(DB 트리에서도 folders/links 순서 정보가 없으므로 이 순서로 고정한다)
function renderChildren(tree: ExportTree, depth: number): string[] {
  const lines: string[] = []
  for (const link of tree.links) lines.push(renderLink(link, depth))
  for (const folder of tree.folders) lines.push(renderFolder(folder, depth))
  return lines
}

/** 북마크 트리를 Netscape 북마크 HTML 문자열로 직렬화한다 */
export function toNetscapeHtml(tree: ExportTree): string {
  const body = renderChildren(tree, 1).join('\n')
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    body,
    '</DL><p>',
    ''
  ].join('\n')
}
