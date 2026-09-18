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
    <div className="flex items-center gap-3 border-b border-[var(--line)] bg-white px-3.5 py-2 text-[12.5px]">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
      <b className="font-semibold">{label}</b>
      <span className="text-[var(--text3)]">{t('chat.toolCalls', { n: toolCalls, max })}</span>
      <span className="flex-1" />
      <button
        onClick={onStop}
        className="flex h-7 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 font-medium text-[var(--danger)]"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        {t('chat.stop')}
      </button>
    </div>
  )
}
