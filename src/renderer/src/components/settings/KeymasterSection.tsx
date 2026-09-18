import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@renderer/stores/uiStore'
import { NotReadyNote, PrimaryButton, SecondaryButton, SettingsSection } from './shared'
import { useState } from 'react'

// 키마스터 — 2단계에서 만든 화면으로 보내기만 한다(재구현 없음).
// 내보내기는 Task 14 에서 IPC 가 붙는다
export function KeymasterSection(): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const [exportNotice, setExportNotice] = useState(false)

  return (
    <SettingsSection
      title={t('settingsPage.vault.title')}
      description={t('settingsPage.vault.descriptionDetail')}
    >
      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={() => setView('personal')}>
          {t('settingsPage.keymaster.open')}
        </PrimaryButton>
        <SecondaryButton onClick={() => setExportNotice(true)}>
          {t('settingsPage.keymaster.export')}
        </SecondaryButton>
      </div>
      {exportNotice && <NotReadyNote text={t('settingsPage.keymaster.exportUnavailable')} />}
    </SettingsSection>
  )
}
