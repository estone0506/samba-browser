import { useRef } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { PhoneDto } from '@shared/phone'
import { SecondaryButton, StatusBadge } from '@renderer/components/settings/shared'
import { PhoneManualPad } from './PhoneManualPad'
import { useH264Player } from './useH264Player'
import { isSwipe, screenBadgeKey, toViewRatio } from './phone-view'

// 폰 화면 확대 뷰.
// 캔버스 위 클릭·드래그를 0~1 비율로 바꿔 메인에 넘긴다 — 실제 폰 해상도 환산은
// 폰 해상도를 아는 메인 쪽(toDeviceCoord)이 맡는다
export function PhoneScreenView({
  phone,
  active
}: {
  phone: PhoneDto
  active: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const { status, mode } = useH264Player(canvasRef, { serial: phone.serial, active })
  const badge = screenBadgeKey(mode)
  const inputReady = typeof window.samba.phone.tap === 'function'

  const localPoint = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!inputReady) return
    startRef.current = localPoint(e)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = startRef.current
    startRef.current = null
    if (!start || !inputReady) return
    const rect = e.currentTarget.getBoundingClientRect()
    const end = localPoint(e)
    const from = toViewRatio(start.x, start.y, rect)
    const to = toViewRatio(end.x, end.y, rect)
    if (isSwipe(start.x, start.y, end.x, end.y)) {
      void window.samba.phone.swipe?.(phone.serial, from.rx, from.ry, to.rx, to.ry)
    } else {
      void window.samba.phone.tap?.(phone.serial, to.rx, to.ry)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative overflow-hidden rounded-xl border border-[var(--line)] bg-black">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          className="block h-auto w-full touch-none select-none"
          aria-label={t('phone.screen.canvasLabel', { name: phone.label })}
        />
        {status !== 'playing' && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] text-white/70">
            {status === 'unavailable'
              ? t('phone.screen.unavailable')
              : status === 'failed'
                ? t('phone.screen.failed')
                : t('phone.screen.starting')}
          </div>
        )}
        {badge && (
          <div className="absolute left-2 top-2">
            <StatusBadge label={t(badge)} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <PhoneManualPad serial={phone.serial} />
        <SecondaryButton
          disabled={typeof window.samba.phone.openWindow !== 'function'}
          onClick={() => void window.samba.phone.openWindow?.(phone.serial)}
          className="h-[30px]"
        >
          {t('phone.screen.openWindow')}
        </SecondaryButton>
      </div>
      {!inputReady && (
        <p className="text-[11px] text-[var(--text2)]">{t('phone.screen.inputUnavailable')}</p>
      )}
    </div>
  )
}
