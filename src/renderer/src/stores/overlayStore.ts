import { create } from 'zustand'

/**
 * 네이티브 WebContentsView 는 항상 렌더러 위에 그려지므로, 웹뷰 영역까지 내려오는
 * 렌더러 팝오버(주소창 오른쪽 퍼즐 메뉴 등)는 그냥 두면 가려진다.
 *
 * 그래서 그런 팝오버가 열려 있는 동안에는 웹뷰를 잠시 접는다. WebArea 가 이 값을 보고
 * 좌표를 0 으로 보고하고, 닫으면 다시 제 크기를 보고한다.
 * 키마스터 패널처럼 웹뷰 밖(오른쪽 패널)에 그리는 것들은 이 상태를 쓸 일이 없다
 */
interface OverlayState {
  webviewHidden: boolean
  setWebviewHidden: (v: boolean) => void
}

export const useOverlayStore = create<OverlayState>((set) => ({
  webviewHidden: false,
  setWebviewHidden: (v) => set({ webviewHidden: v })
}))
