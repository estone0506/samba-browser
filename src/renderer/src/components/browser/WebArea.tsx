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
  useLayoutEffect(send)
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
  return <div ref={ref} className="flex-1 bg-white" />
}
