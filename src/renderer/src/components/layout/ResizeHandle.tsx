import { useRef } from 'react'
import type React from 'react'
import { useUiStore } from '@renderer/stores/uiStore'

interface Props {
  // 드래그 시작 시점의 폭을 읽고, 이동량을 더해 새 폭을 돌려준다
  getWidth: () => number
  onWidth: (w: number) => void
  // 손잡이가 패널의 오른쪽 가장자리에 있으면(사이드바) 오른쪽으로 끌수록 폭이 커지고,
  // 왼쪽 가장자리에 있으면(AI 패널) 반대다
  side: 'left' | 'right'
  // 드래그가 끝났을 때 최종 폭(영속 저장용)
  onEnd?: (w: number) => void
}

/**
 * 세로 드래그 손잡이(6px). 포인터 캡처로 드래그를 이어 가고, 드래그 중에는 uiStore.resizing 을
 * 켜서 네이티브 웹뷰가 포인터를 가로채지 않게 한다(WebArea 가 뷰를 잠시 접는다)
 */
export function ResizeHandle({ getWidth, onWidth, side, onEnd }: Props): React.JSX.Element {
  const setResizing = useUiStore((s) => s.setResizing)
  const start = useRef<{ x: number; w: number } | null>(null)
  const last = useRef<number>(0)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: getWidth() }
        last.current = start.current.w
        setResizing(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const delta = e.clientX - start.current.x
        const next = side === 'right' ? start.current.w + delta : start.current.w - delta
        last.current = next
        onWidth(next)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        start.current = null
        setResizing(false)
        onEnd?.(last.current)
      }}
      onPointerCancel={() => {
        start.current = null
        setResizing(false)
      }}
      className="group relative z-10 -mx-0.5 w-2.5 shrink-0 cursor-col-resize select-none"
    >
      {/* 얇은 선은 평소엔 투명, 올리면 살짝 보인다 */}
      <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded bg-transparent transition-colors group-hover:bg-black/15" />
    </div>
  )
}
