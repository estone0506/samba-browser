// 툴바 버튼의 화면 좌표를 메인에 넘길 형태로 만든다.
// 컴포넌트 파일과 나눠 둔 이유는 하나뿐이다 — 컴포넌트 파일이 컴포넌트만 내보내야
// 빠른 새로고침(react-refresh)이 동작하기 때문이다

import type { ExtensionAnchorDto } from '@shared/extensions'

/** 버튼의 화면 좌표 — 메인이 이 아래에 확장 팝업 문서를 붙인다 */
export function anchorOf(el: HTMLElement): ExtensionAnchorDto {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
    // 메인이 지금 창 크기에 다시 투영할 수 있도록 측정 기준 뷰포트도 함께 보낸다
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  }
}
