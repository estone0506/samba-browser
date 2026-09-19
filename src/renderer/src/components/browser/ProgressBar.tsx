import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'
import type { TaskProgress } from '@renderer/stores/chatStore'

interface Props {
  running: boolean
  label: string
  toolCalls: number
  max: number
  // 여러 건짜리 작업의 진행 상황(progress 도구). 없으면 배지를 숨긴다
  progress?: TaskProgress | null
  onStop: () => void
}

export function ProgressBar({
  running,
  label,
  toolCalls,
  max,
  progress,
  onStop
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!running) return null
  return (
    // 창 드래그 영역·웹뷰에 가려지지 않도록 no-drag + 위쪽 레이어로 둔다
    <div className="relative z-20 flex items-center gap-3 border-b border-[var(--line)] bg-white px-3.5 py-2 text-[12.5px] [-webkit-app-region:no-drag]">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
      <b className="font-semibold">{label}</b>
      {/* 플레이북이 알려 준 진행 상황 — "주문 이행 3/26" 형태의 배지 */}
      {progress && (
        <span className="inline-flex h-[20px] max-w-[280px] items-center gap-1 truncate rounded-full border border-[var(--text)] bg-[var(--text)] px-2 text-[11px] font-medium text-white">
          {progress.label ? `${progress.label} ` : ''}
          {t('automation.progress', { done: progress.done, total: progress.total })}
        </span>
      )}
      <span className="text-[var(--text3)]">{t('chat.toolCalls', { n: toolCalls, max })}</span>
      <span className="flex-1" />
      <button
        onClick={onStop}
        className="relative z-20 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 font-medium text-[var(--danger)] [-webkit-app-region:no-drag]"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        {t('chat.stop')}
      </button>
    </div>
  )
}
