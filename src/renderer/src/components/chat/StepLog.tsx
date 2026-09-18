import type React from 'react'
import { Check, X } from 'lucide-react'
import type { Step } from '@renderer/stores/chatStore'

export function StepLog({
  steps,
  running
}: {
  steps: Step[]
  running: boolean
}): React.JSX.Element | null {
  if (!steps.length) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-[var(--text2)]">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1
        return (
          <div key={i} className="flex items-center gap-2">
            {running && isLast ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
            ) : s.ok ? (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--ok)]">
                <Check className="h-2.5 w-2.5 stroke-[3] text-white" />
              </span>
            ) : (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--danger)]">
                <X className="h-2.5 w-2.5 stroke-[3] text-white" />
              </span>
            )}
            <span>{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}
