// Netscape 북마크 HTML(크롬/웨일/엣지/파이어폭스/사파리 export 공통 형식) 가져오기 파서
// 순수 함수 — Electron 의존성 없음

import { parse, type HTMLElement, type Node } from 'node-html-parser'

export interface BookmarkLink {
  title: string
  url: string
  addDate?: number
  icon?: string
}

export interface BookmarkFolderNode {
  name: string
  addDate?: number
  isToolbar: boolean
  folders: BookmarkFolderNode[]
  links: BookmarkLink[]
}

export interface BookmarkTree {
  folders: BookmarkFolderNode[]
  links: BookmarkLink[]
}

// 가져오기를 거부할 위험한/무의미한 URL 스킴
const BLOCKED_URL_PREFIXES = ['javascript:', 'place:']

const ELEMENT_NODE_TYPE = 1

function isElementNode(node: Node): node is HTMLElement {
  return node.nodeType === ELEMENT_NODE_TYPE
}

/** ADD_DATE 속성을 숫자로 파싱한다. 없거나 숫자가 아니면 undefined */
function parseAddDate(el: HTMLElement): number | undefined {
  const raw = el.getAttribute('ADD_DATE')
  if (raw === undefined) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isNaN(value) ? undefined : value
}

function isBlockedUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return BLOCKED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** <A> 요소를 BookmarkLink 로 변환한다. 위험한 스킴이면 undefined */
function buildLink(a: HTMLElement): BookmarkLink | undefined {
  const url = (a.getAttribute('HREF') ?? '').trim()
  if (!url || isBlockedUrl(url)) return undefined

  const link: BookmarkLink = {
    title: a.text.trim(),
    url
  }
  const addDate = parseAddDate(a)
  if (addDate !== undefined) link.addDate = addDate
  const icon = a.getAttribute('ICON')
  if (icon !== undefined) link.icon = icon
  return link
}

/** DL 요소의 바로 다음 형제(같은 부모의 다음 child)가 DL 이면 반환한다 */
function findFollowingDl(children: HTMLElement[], index: number): HTMLElement | undefined {
  const next = children[index + 1]
  if (next && next.tagName === 'DL') return next
  return undefined
}

/** DL 요소 하나를 순회해 그 안의 폴더·링크 목록을 순서대로 만든다 */
function walkDl(dl: HTMLElement, dedupe: boolean, seenUrls: Set<string>): BookmarkTree {
  const folders: BookmarkFolderNode[] = []
  const links: BookmarkLink[] = []
  const children = dl.childNodes.filter(isElementNode)

  for (let i = 0; i < children.length; i++) {
    const el = children[i]
    if (el.tagName === 'A') {
      const link = buildLink(el)
      if (!link) continue
      if (dedupe) {
        if (seenUrls.has(link.url)) continue
        seenUrls.add(link.url)
      }
      links.push(link)
    } else if (el.tagName === 'H3') {
      const nestedDl = findFollowingDl(children, i)
      const contents = nestedDl ? walkDl(nestedDl, dedupe, seenUrls) : { folders: [], links: [] }
      const folder: BookmarkFolderNode = {
        name: el.text.trim(),
        isToolbar: (el.getAttribute('PERSONAL_TOOLBAR_FOLDER') ?? '').toLowerCase() === 'true',
        folders: contents.folders,
        links: contents.links
      }
      const addDate = parseAddDate(el)
      if (addDate !== undefined) folder.addDate = addDate
      folders.push(folder)
    }
    // DL 태그 자체는 앞선 H3 처리 시 findFollowingDl 로 소비되므로 별도 처리하지 않는다
  }

  return { folders, links }
}

/**
 * Netscape 북마크 HTML 문자열을 파싱해 폴더/링크 트리로 변환한다.
 * <DT> 는 구조상 의미 없는 마커 태그이고 <p> 도 레이아웃용이라, DOM 파싱 전에 제거해
 * <DL>/<H3>/<A> 만 남긴 뒤 순회한다.
 */
export function parseNetscapeBookmarks(
  html: string,
  opts: { dedupeUrls?: boolean } = {}
): BookmarkTree {
  const cleaned = html.replace(/<DT>/gi, '').replace(/<\/?p>/gi, '')
  const root = parse(cleaned)
  const rootDl = root.querySelector('dl')
  if (!rootDl) return { folders: [], links: [] }

  const seenUrls = new Set<string>()
  return walkDl(rootDl, opts.dedupeUrls === true, seenUrls)
}
