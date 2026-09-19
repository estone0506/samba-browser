import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import { useBrowserStore } from '../../stores/browserStore'
import { useUiStore } from '../../stores/uiStore'
import { useOverlayStore } from '../../stores/overlayStore'

// 실제 웹페이지(WebContentsView)는 메인이 그림. 이 컴포넌트는 빈 자리를 만들고 좌표만 보고
export function WebArea(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const mobile = useBrowserStore((s) => s.activeTab?.mobile ?? false)
  // 구독만으로도 resizing·팝오버·캡처 오버레이가 바뀌면 리렌더 → useLayoutEffect 가 다시 측정한다
  useUiStore((s) => s.resizing)
  useUiStore((s) => s.captureOverlayOpen)
  useOverlayStore((s) => s.webviewHidden)
  const snapshot = useOverlayStore((s) => s.snapshot)
  const send = useCallback((): void => {
    const el = ref.current
    if (!el) return
    // 패널 폭을 드래그하는 동안은 네이티브 뷰를 접어 둔다. 뷰가 렌더러 위에 떠 있어
    // 포인터가 그 위로 가면 드래그가 끊기기 때문. 놓으면 원래 크기로 다시 보고된다.
    // 웹뷰 위로 내려오는 렌더러 팝오버(퍼즐 메뉴 등)·캡처 '직접 지정' 오버레이가 떠 있을 때도
    // 같은 이유로 접는다 — 네이티브 뷰는 항상 렌더러 위에 그려져 접지 않으면 가려진다
    const ui = useUiStore.getState()
    if (ui.resizing || ui.captureOverlayOpen || useOverlayStore.getState().webviewHidden) {
      void window.samba.layout.set({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
      return
    }
    const r = el.getBoundingClientRect()
    // 가장자리를 각각 반올림한 뒤 빼서 폭·높이를 낸다.
    // width 를 따로 반올림하면 서브픽셀 위치에서 오른쪽·아래가 1px 어긋난다
    const x = Math.round(r.left)
    const y = Math.round(r.top)
    void window.samba.layout.set({
      x,
      y,
      width: Math.round(r.right) - x,
      height: Math.round(r.bottom) - y,
      // 메인이 여백을 현재 창 크기에 다시 투영할 수 있도록 측정 기준 뷰포트도 같이 보낸다
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    })
  }, [])
  // 진행 띠가 나타나고 사라질 때 웹뷰가 잠깐 버튼 위를 덮지 않도록,
  // 화면이 그려지기 전에 매 렌더마다 좌표를 다시 보고한다
  useLayoutEffect(() => {
    send()
    // 폰트 스왑(FOUT)·서브픽셀 반올림 등으로 커밋 직후엔 아직 최종 레이아웃이
    // 아닐 수 있어, 다음 프레임에 한 번 더 측정해 어긋남을 바로잡는다
    const raf = requestAnimationFrame(send)
    return () => cancelAnimationFrame(raf)
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
  }, [send])
  // min-h-0: flex-col 안에서 내용이 없어도 자동 최소 높이(auto)로 인해
  // 카드 밖으로 넘치지 않도록 보정.
  // 네이티브 WebContentsView 가 이 div 바로 위에 겹쳐 그려지므로, 여기 배경/placeholder 는
  // 뷰가 아직 붙기 전(로딩 전환 등) 또는 뷰 경계 밖으로 보이는 여백을 위한 시각 보조일 뿐이다.
  // 모바일: 양옆 여백을 앱 배경색으로, 가운데에 412px 폭 카드 느낌의 placeholder 를 깔아
  // 웨일 모바일 창처럼 보이게 한다(실제 정렬은 tab-manager 의 computeViewBounds 가 담당)
  return (
    <div ref={ref} className="min-h-0 flex-1 bg-[var(--bg)]">
      {snapshot && (
        // 웹뷰를 접은 동안 그 자리에 정지 이미지를 깔아 페이지가 사라져 보이지 않게 한다
        <img
          src={snapshot.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none fixed select-none"
          style={{
            left: snapshot.rect.x,
            top: snapshot.rect.y,
            width: snapshot.rect.width,
            height: snapshot.rect.height
          }}
        />
      )}
      {mobile && !snapshot && (
        <div className="flex h-full w-full items-stretch justify-center">
          <div className="w-[412px] max-w-full rounded-t-2xl bg-white shadow-lg" />
        </div>
      )}
    </div>
  )
}
