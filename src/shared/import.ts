// 가져오기(비밀번호 CSV·북마크 HTML) 공용 DTO — 메인·프리로드·렌더러가 함께 쓴다.
// 어떤 타입에도 비밀번호·URL 원문 같은 민감한 행 데이터는 담기지 않는다(카운트·트리 구조만).

export interface ImportPasswordsResult {
  total: number
  added: number
  updated: number
  skipped: number
  sites: number
}

export interface ImportBookmarksResult {
  folders: number
  bookmarks: number
  skipped: number
}

export interface BookmarkLinkDto {
  id: number
  title: string
  url: string
}

export interface BookmarkFolderDto {
  id: number
  name: string
  isToolbar: boolean
  folders: BookmarkFolderDto[]
  links: BookmarkLinkDto[]
}

export interface BookmarkTreeDto {
  folders: BookmarkFolderDto[]
  links: BookmarkLinkDto[]
}
