// 자체 새 탭 페이지(samba://newtab)와 메인 프로세스가 주고받는 DTO.
// 새 탭 페이지는 렌더러(React UI)와 별개의 정적 페이지라 최소한의 데이터만 받는다.

// 새 탭에 보여 줄 북마크 바 상위 항목 수 상한
export const NEW_TAB_BOOKMARK_LIMIT = 8

export interface NewTabBookmarkDto {
  title: string
  url: string
  // 파비콘 조회용 호스트(예: naver.com). URL 파싱은 메인에서 끝낸다
  host: string
  // 메인이 캐시에서 찾은 파비콘 dataUrl. 없으면 페이지가 첫 글자 폴백을 그린다
  favicon?: string
}

export interface NewTabInitDto {
  language: 'ko' | 'en'
  bookmarks: NewTabBookmarkDto[]
}

// preload 가 새 탭 페이지의 메인 월드에 노출하는 API
export interface SambaNewTabApi {
  init: () => Promise<NewTabInitDto>
  // 검색어 또는 URL. 변환·허용 판정은 메인이 한다
  search: (input: string) => void
  open: (url: string) => void
}
