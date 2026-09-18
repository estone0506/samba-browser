import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'

export function AuthBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { authError } = useChatStore()
  if (!authError) return null
  return (
    <div className="mx-3 mt-3 rounded-xl border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-3 py-2 text-[12.5px]">
      {t(`auth.${authError}`)}
    </div>
  )
}
