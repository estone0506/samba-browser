import { isInternalUrl } from '@shared/url'

// 주소창에 보여 줄 문자열. 내부 페이지(자체 새 탭)는 주소를 숨기고 안내 문구만 남긴다
export function displayUrl(url: string | undefined): string {
  if (!url || isInternalUrl(url)) return ''
  return url
}
