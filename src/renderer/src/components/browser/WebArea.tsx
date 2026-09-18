import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type React from 'react'

// 실제 웹페이지(WebContentsView)는 메인이 그림. 이 컴포넌트는 빈 자리를 만들고 좌표만 보고
export function WebArea(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const send = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void window.samba.layout.set({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
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
  // 카드 밖으로 넘치지 않도록 보정
  return <div ref={ref} className="min-h-0 flex-1 bg-white" />
}
