import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'

interface Props {
  running: boolean
  label: string
  toolCalls: number
  max: number
  onStop: () => void
}

export function ProgressBar({
  running,
  label,
  toolCalls,
  max,
  onStop
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!running) return null
  return (
    // 창 드래그 영역·웹뷰에 가려지지 않도록 no-drag + 위쪽 레이어로 둔다
    <div className="relative z-20 flex items-center gap-3 border-b border-[var(--line)] bg-white px-3.5 py-2 text-[12.5px] [-webkit-app-region:no-drag]">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
      <b className="font-semibold">{label}</b>
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
