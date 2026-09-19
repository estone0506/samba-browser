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

// 정지 이미지가 늦게 도착했을 때 이미 닫힌 상태를 덮어쓰지 않기 위한 일련번호
let ticket = 0

export const useOverlayStore = create<OverlayState>((set, get) => ({
  webviewHidden: false,
  snapshot: null,
  setWebviewHidden: (v) => {
    const mine = ++ticket
    if (!v) {
      set({ webviewHidden: false, snapshot: null })
      return
    }
    if (get().webviewHidden) return
    // 접힘은 즉시(동기) 반영한다 — 비동기 완료를 기다리면 열기/닫기가 엇갈려 접힌 채 남을 수 있다.
    // 정지 이미지 요청은 접기보다 먼저 보내 두므로(IPC 순서 보장) 아직 보이는 웹뷰를 찍는다
    const still = window.samba.capture?.still
    const pending = still ? still().catch(() => null) : Promise.resolve(null)
    set({ webviewHidden: true, snapshot: null })
    void pending.then((r) => {
      if (mine !== ticket || !get().webviewHidden) return
      if (r && r.ok && r.data.rect.width > 0)
        set({ snapshot: { dataUrl: r.data.dataUrl, rect: r.data.rect } })
    })
  }
}))
