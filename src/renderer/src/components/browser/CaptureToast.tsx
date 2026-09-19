import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useCaptureStore } from '@renderer/stores/captureStore'
import { isVideoCaptureMode } from '@shared/capture'

// 저장 후 미리보기 토스트 — 열기 · 폴더 열기 · 클립보드 복사
const AUTO_DISMISS_MS = 8000

export function CaptureToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const toast = useCaptureStore((s) => s.toast)
  const dismiss = useCaptureStore((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])

  if (!toast) return null
  const isVideo = isVideoCaptureMode(toast.mode)

  return (
    <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-white/95 p-3 shadow-[0_8px_28px_rgba(0,0,0,.16)] backdrop-blur">
        {toast.previewDataUrl ? (
          <img
            src={toast.previewDataUrl}
            alt=""
            className="h-14 w-24 rounded-[10px] border border-[var(--line)] object-cover"
          />
        ) : (
          <div className="flex h-14 w-24 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--bg)] text-[11px] text-[var(--text2)]">
            webm
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-[var(--text)]">
            {t('screenCapture.saved')}
          </div>
          <div className="max-w-[220px] truncate text-[11px] text-[var(--text2)]">
            {toast.fileName}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ToastAction
              label={t('screenCapture.open')}
              onClick={() => void window.samba.capture.openFile(toast.filePath)}
            />
            <ToastAction
              label={t('screenCapture.openFolder')}
              onClick={() => void window.samba.capture.openFolder(toast.filePath)}
            />
            {!isVideo && (
              <ToastAction
                label={t('screenCapture.copy')}
                onClick={() => void window.samba.capture.copyImage(toast.filePath)}
              />
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title={t('screenCapture.dismiss')}
          className="self-start rounded-lg p-1 text-[var(--text2)] hover:bg-black/5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function ToastAction({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-[26px] rounded-[8px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text)] hover:bg-black/5"
    >
      {label}
    </button>
  )
}
