import { create } from 'zustand'
import type { CaptureRect } from '@shared/capture'

/**
 * 네이티브 WebContentsView 는 항상 렌더러 위에 그려지므로, 웹뷰 영역까지 내려오는
 * 렌더러 팝오버(주소창 오른쪽 퍼즐·번역·캡처 메뉴 등)는 그냥 두면 가려진다.
 *
 * 그래서 그런 팝오버가 열려 있는 동안에는 웹뷰를 잠시 접는다. WebArea 가 이 값을 보고
 * 좌표를 0 으로 보고하고, 닫으면 다시 제 크기를 보고한다.
 *
 * 접는 순간 페이지가 사라져 보이지 않도록, 접기 직전에 웹뷰 정지 이미지를 한 장 찍어
 * 같은 자리에 깔아 둔다(웨일처럼 메뉴 뒤로 페이지가 그대로 보이는 효과). 닫으면 지운다.
 * 키마스터 패널처럼 웹뷰 밖(오른쪽 패널)에 그리는 것들은 이 상태를 쓸 일이 없다
 */
export interface WebviewSnapshot {
  dataUrl: string
  rect: CaptureRect
}

interface OverlayState {
  webviewHidden: boolean
  snapshot: WebviewSnapshot | null
  setWebviewHidden: (v: boolean) => void
}

// 열기 요청 뒤 닫기 요청이 먼저 처리되는 경합을 막는 일련번호
let ticket = 0

export const useOverlayStore = create<OverlayState>((set) => ({
  webviewHidden: false,
  snapshot: null,
  setWebviewHidden: (v) => {
    const mine = ++ticket
    if (!v) {
      set({ webviewHidden: false, snapshot: null })
      return
    }
    // 정지 이미지는 웹뷰가 아직 보일 때 찍어야 하므로 접기 전에 먼저 요청한다.
    // 실패해도(빈 탭 등) 접기는 진행한다
    const still = window.samba.capture?.still
    if (!still) {
      set({ webviewHidden: true, snapshot: null })
      return
    }
    void still()
      .then((r) => {
        if (mine !== ticket) return
        set({
          webviewHidden: true,
          snapshot:
            r.ok && r.data.rect.width > 0 ? { dataUrl: r.data.dataUrl, rect: r.data.rect } : null
        })
      })
      .catch(() => {
        if (mine === ticket) set({ webviewHidden: true, snapshot: null })
      })
  }
}))
