import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Settings as SettingsIcon, Square } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useCaptureStore, formatElapsed, RECORDING_BUSY_KEY } from '@renderer/stores/captureStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { CaptureOverlay } from './CaptureOverlay'
import { CaptureToast } from './CaptureToast'
import { useOverlayStore } from '@renderer/stores/overlayStore'
import {
  DEFAULT_CAPTURE_SHORTCUTS,
  IMAGE_CAPTURE_MODES,
  shortenCapturePath,
  VIDEO_CAPTURE_MODES,
  type CaptureMode,
  type CaptureShortcuts
} from '@shared/capture'

// 툴바 캡처 메뉴(웨일 캡처 메뉴와 같은 구성).
//   이미지  직접 지정 · 영역 선택 · 전체 페이지 · 전체 화면
//   비디오  직접 지정 · 전체 화면
//   설정
// 녹화 중에는 메뉴 자리에 빨간 점 · 경과 시간 · [중지] 가 대신 뜬다
export function CaptureMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [shortcuts, setShortcuts] = useState<CaptureShortcuts>(DEFAULT_CAPTURE_SHORTCUTS)
  const [dir, setDir] = useState('')
  const start = useCaptureStore((s) => s.start)
  const recordingMode = useCaptureStore((s) => s.recordingMode)
  const elapsed = useCaptureStore((s) => s.elapsed)
  const stopRecording = useCaptureStore((s) => s.stopRecording)
  const error = useCaptureStore((s) => s.error)
  const clearError = useCaptureStore((s) => s.clearError)
  const showToast = useCaptureStore((s) => s.showToast)
  const setView = useUiStore((s) => s.setView)

  // 열려 있는 동안에는 네이티브 웹뷰를 접는다 — 접지 않으면 팝오버가 그 아래로 가려져 안 보인다
  const setWebviewHidden = useOverlayStore((s) => s.setWebviewHidden)
  useEffect(() => {
    setWebviewHidden(open)
    return () => setWebviewHidden(false)
  }, [open, setWebviewHidden])

  // 단축키 표·저장 폴더는 설정에서 바뀔 수 있으므로 메뉴를 열 때마다 최신 값을 읽는다
  useEffect(() => {
    if (!open) return
    void window.samba.settings.get().then((r) => {
      if (r.ok) setShortcuts(r.data.captureShortcuts)
    })
    void window.samba.capture.dir().then((r) => {
      if (r.ok) setDir(r.data)
    })
  }, [open])

  // 메뉴 안에서 바로 저장 폴더를 바꾼다(설정 화면까지 들어가지 않아도 되게)
  const changeDir = (): void => {
    void window.samba.capture.pickDir().then((r) => {
      if (r.ok && r.data) setDir(r.data)
    })
  }

  // 단축키(Alt+1~6)는 메인이 창 안에서 듣고 방식만 알려 준다 — 메뉴를 누른 것과 같은 경로를 탄다
  useEffect(() => {
    const offShortcut = window.samba.capture.onShortcut((mode) => {
      void start(mode)
    })
    const offDone = window.samba.capture.onDone(showToast)
    return () => {
      offShortcut()
      offDone()
    }
  }, [start, showToast])

  // 오류 문구는 잠깐만 보여 준다
  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(clearError, 5000)
    return () => window.clearTimeout(timer)
  }, [error, clearError])

  const choose = (mode: CaptureMode): void => {
    setOpen(false)
    void start(mode)
  }

  // 녹화 중 표시(타이머 + 중지). 카메라 메뉴 버튼과는 별개로 둔다 —
  // 예전엔 카메라 자리가 이 버튼으로 바뀌어, 이미지 캡처하려다 녹화가 끊기는 일이 있었다
  const recordingPill = recordingMode ? (
    <button
      type="button"
      onClick={() => void stopRecording()}
      title={t('screenCapture.stop')}
      className="mr-1 flex h-7 items-center gap-1.5 rounded-lg border border-[#b91c1c] px-2 text-[11.5px] font-medium text-[#b91c1c]"
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-[#b91c1c]" />
      <span className="tabular-nums">{formatElapsed(elapsed)}</span>
      <Square className="h-3 w-3 fill-current" />
    </button>
  ) : null

  return (
    <>
      {recordingPill}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t('screenCapture.title')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5"
          >
            <Camera className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60">
          {recordingMode && (
            <>
              <MenuItem
                label={`${t('screenCapture.stop')} · ${formatElapsed(elapsed)}`}
                onClick={() => {
                  setOpen(false)
                  void stopRecording()
                }}
              />
              <div className="my-1 h-px bg-[var(--line)]" />
            </>
          )}
          <MenuGroup label={t('screenCapture.image')} />
          {IMAGE_CAPTURE_MODES.map((mode) => (
            <MenuItem
              key={mode}
              label={t(`screenCapture.modes.${mode}`)}
              shortcut={shortcuts[mode]}
              onClick={() => choose(mode)}
            />
          ))}
          <MenuGroup label={t('screenCapture.video')} />
          {VIDEO_CAPTURE_MODES.map((mode) => (
            <MenuItem
              key={mode}
              label={t(`screenCapture.modes.${mode}`)}
              shortcut={shortcuts[mode]}
              onClick={() => choose(mode)}
            />
          ))}
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={t('screenCapture.settings')}
            icon={<SettingsIcon className="h-3.5 w-3.5" />}
            onClick={() => {
              setOpen(false)
              setView('settings')
            }}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          {/* 저장 폴더를 메뉴에서 바로 보여 주고 바꾸거나 열 수 있게 한다 */}
          <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--text2)]">
            <span className="shrink-0">{t('screenCapture.folder')}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--text3)]" title={dir}>
              {/* 좁은 메뉴라 앞을 접고 폴더 이름 쪽을 남긴다(전체 경로는 툴팁으로) */}
              {dir ? shortenCapturePath(dir, 18) : '…'}
            </span>
            <button
              type="button"
              onClick={changeDir}
              className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[var(--text)] hover:bg-black/5"
            >
              {t('screenCapture.folderChange')}
            </button>
            <button
              type="button"
              onClick={() => void window.samba.capture.openFolder()}
              className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[var(--text)] hover:bg-black/5"
            >
              {t('screenCapture.folderOpen')}
            </button>
          </div>
          {error && (
            <p className="px-2 py-1.5 text-[11px] text-red-500">
              {error === RECORDING_BUSY_KEY ? t(RECORDING_BUSY_KEY) : error}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <CaptureOverlay />
      <CaptureToast />
    </>
  )
}

function MenuGroup({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-medium tracking-wide text-[var(--text2)] uppercase">
      {label}
    </div>
  )
}

function MenuItem({
  label,
  shortcut,
  icon,
  onClick
}: {
  label: string
  shortcut?: string
  icon?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="text-[11px] text-[var(--text3)]">{shortcut}</span>}
    </button>
  )
}
