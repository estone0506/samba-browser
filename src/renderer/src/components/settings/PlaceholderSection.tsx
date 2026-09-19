import type React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection } from './shared'

// 자동화 / 개발자 — 제목과 "다음 단계에서 제공" 안내만 둔다
export function PlaceholderSection({ titleKey }: { titleKey: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t(titleKey)}>
      <p className="text-[12px] text-[var(--text2)]">{t('settingsPage.placeholder')}</p>
    </SettingsSection>
  )
}
