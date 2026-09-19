import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@renderer/i18n'
import { ImportPanel } from '@renderer/components/vault/ImportPanel'
import { MouseGestureCard } from './MouseGestureCard'
import { isHttpUrl, isInternalUrl } from '@shared/url'
import type { NewTabUrlMode, SearchEngine } from '@shared/settings'
import {
  PrimaryButton,
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  TextInput,
  type SectionProps
} from './shared'

// 일반 — 기본 검색엔진 · 시작 화면(홈 주소·새 탭 주소) · 언어 · 가져오기
export function GeneralSection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [homeUrlText, setHomeUrlText] = useState(settings.homeUrl)
  const [homeUrlError, setHomeUrlError] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const commitHomeUrl = (): void => {
    const value = homeUrlText.trim()
    if (!isHttpUrl(value) && !isInternalUrl(value)) {
      setHomeUrlError(true)
      return
    }
    setHomeUrlError(false)
    update({ homeUrl: value })
  }

  const chooseLanguage = (v: 'ko' | 'en'): void => {
    void i18n.changeLanguage(v)
    update({ language: v })
  }

  return (
    <>
      <SettingsSection title={t('settingsPage.general.searchTitle')}>
        <SettingsRow label={t('settingsPage.browser.searchEngine')}>
          <SegmentedGroup<SearchEngine>
            value={settings.searchEngine}
            onChange={(v) => update({ searchEngine: v })}
            options={[
              { value: 'google', label: t('settingsPage.browser.searchEngineGoogle') },
              { value: 'naver', label: t('settingsPage.browser.searchEngineNaver') }
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.general.startupTitle')}>
        <SettingsRow label={t('settingsPage.browser.homeUrl')}>
          <div className="flex items-center gap-2">
            <TextInput
              value={homeUrlText}
              onChange={(v) => {
                setHomeUrlText(v)
                setHomeUrlError(false)
              }}
              onBlur={commitHomeUrl}
              placeholder="https://"
              invalid={homeUrlError}
            />
            <PrimaryButton onClick={commitHomeUrl}>{t('settingsPage.browser.save')}</PrimaryButton>
          </div>
          {homeUrlError && (
            <p className="text-[11px] text-red-500">{t('settingsPage.browser.homeUrlError')}</p>
          )}
        </SettingsRow>

        <SettingsRow label={t('settingsPage.browser.newTabUrl')}>
          <SegmentedGroup<NewTabUrlMode>
            value={settings.newTabUrl}
            onChange={(v) => update({ newTabUrl: v })}
            options={[
              { value: 'home', label: t('settingsPage.browser.newTabUrlHome') },
              { value: 'blank', label: t('settingsPage.browser.newTabUrlBlank') }
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <MouseGestureCard settings={settings} update={update} />

      <SettingsSection title={t('settingsPage.browser.language')}>
        <SegmentedGroup<'ko' | 'en'>
          value={settings.language}
          onChange={chooseLanguage}
          options={[
            { value: 'ko', label: t('settingsPage.browser.languageKo') },
            { value: 'en', label: t('settingsPage.browser.languageEn') }
          ]}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settingsPage.general.importTitle')}
        description={t('settingsPage.general.importDesc')}
      >
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={() => setImportOpen(true)}>
            {t('vault.import.passwordsButton')}
          </SecondaryButton>
          <SecondaryButton onClick={() => setImportOpen(true)}>
            {t('vault.import.bookmarksButton')}
          </SecondaryButton>
        </div>
      </SettingsSection>

      <ImportPanel open={importOpen} onOpenChange={setImportOpen} />
    </>
  )
}
