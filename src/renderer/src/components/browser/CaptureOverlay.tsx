import { useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useCaptureStore } from '@renderer/stores/captureStore'
import { normalizeDragRect } from '@shared/capture'

// 캡처 '직접 지정' 오버레이.
// 웹뷰를 먼저 한 장 찍어 둔 정지 이미지를 웹뷰가 있던 자리에 그대로 띄우고,
// 그 위에서 드래그로 사각 영역을 고른다(네이티브 웹뷰는 그동안 접혀 있다)
export function CaptureOverlay(): React.JSX.Element | null {
  const { t } = useTranslation()
  const still = useCaptureStore((s) => s.still)
  const closeStill = useCaptureStore((s) => s.closeStill)
  const cropAndSave = useCaptureStore((s) => s.cropAndSave)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  if (!still) return null

  // 화면 좌표 → 정지 이미지 안의 CSS 픽셀 좌표
  const toLocal = (e: React.PointerEvent): { x: number; y: number } => {
    const box = surfaceRef.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    return {
      x: Math.min(Math.max(0, e.clientX - box.left), box.width),
      y: Math.min(Math.max(0, e.clientY - box.top), box.height)
    }
  }

  const selection = origin && cursor ? normalizeDragRect(origin, cursor) : null

  return (
    <div
      className="fixed inset-0 z-50"
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeStill()
      }}
      role="presentation"
    >
      <div
        ref={surfaceRef}
        className="absolute cursor-crosshair select-none overflow-hidden bg-white"
        style={{
          left: still.rect.x,
          top: still.rect.y,
          width: still.rect.width,
          height: still.rect.height
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = toLocal(e)
          setOrigin(p)
          setCursor(p)
        }}
        onPointerMove={(e) => {
          if (origin) setCursor(toLocal(e))
        }}
        onPointerUp={(e) => {
          const end = toLocal(e)
          const from = origin
          setOrigin(null)
          setCursor(null)
          if (!from) return
          const rect = normalizeDragRect(from, end)
          // 클릭에 가까운 아주 작은 영역은 실수로 본다 — 저장하지 않고 오버레이만 닫는다
          if (rect.width < 4 || rect.height < 4) {
            closeStill()
            return
          }
          void cropAndSave(from, end)
        }}
      >
        <img
          src={still.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full object-fill"
        />
        {/* 고르지 않은 부분을 어둡게 — 선택 영역만 원래 밝기로 남는다 */}
        <div className="pointer-events-none absolute inset-0 bg-black/35" />
        {selection && (
          <div
            className="pointer-events-none absolute border-2 border-[#0a84ff] bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,.35)]"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.width,
              height: selection.height
            }}
          >
            <span className="absolute -top-6 left-0 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white">
              {selection.width} × {selection.height}
            </span>
          </div>
        )}
        {!selection && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-medium text-white">
            {t('screenCapture.dragHint')}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={closeStill}
        className="absolute right-4 top-4 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-medium text-white"
      >
        {t('screenCapture.cancel')}
      </button>
    </div>
  )
}
