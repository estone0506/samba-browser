import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { addAutoDomain, removeAutoDomain, TRANSLATE_LANGS } from '@shared/translate'
import type { TranslateLang } from '@shared/translate'
import {
  PrimaryButton,
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  TextInput,
  type SectionProps
} from './shared'

// 설정 → 일반 의 "번역" 카드. 기본 대상 언어 · 자동 번역 도메인 · 캐시 지우기
export function TranslateCard({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [domainText, setDomainText] = useState('')
  const [cacheNote, setCacheNote] = useState('')

  const addDomain = (): void => {
    const next = addAutoDomain(settings.translateAutoDomains, domainText)
    setDomainText('')
    update({ translateAutoDomains: next })
  }

  const clearCache = (): void => {
    void window.samba.translate.clearCache().then((r) => {
      setCacheNote(r.ok ? t('settingsPage.translate.cacheCleared') : t('translate.needsAi'))
    })
  }

  return (
    <SettingsSection
      title={t('settingsPage.translate.title')}
      description={t('settingsPage.translate.desc')}
    >
      <SettingsRow label={t('settingsPage.translate.targetLang')}>
        <SegmentedGroup<TranslateLang>
          value={settings.translateTargetLang}
          onChange={(v) => update({ translateTargetLang: v })}
          options={TRANSLATE_LANGS.map((v) => ({ value: v, label: t(`translate.lang.${v}`) }))}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settingsPage.translate.autoDomains')}
        description={t('settingsPage.translate.autoDomainsDesc')}
      >
        <div className="flex items-center gap-2">
          <TextInput value={domainText} onChange={setDomainText} placeholder="example.com" />
          <PrimaryButton onClick={addDomain} disabled={!domainText.trim()}>
            {t('settingsPage.translate.add')}
          </PrimaryButton>
        </div>
        {settings.translateAutoDomains.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {settings.translateAutoDomains.map((host) => (
              <li key={host}>
                <button
                  type="button"
                  onClick={() =>
                    update({
                      translateAutoDomains: removeAutoDomain(settings.translateAutoDomains, host)
                    })
                  }
                  className="h-[26px] rounded-full border border-[var(--line)] px-2.5 text-[11.5px] text-[var(--text2)] hover:bg-black/5"
                  title={t('settingsPage.translate.remove')}
                >
                  {host} ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>

      <SettingsRow
        label={t('settingsPage.translate.cache')}
        description={t('settingsPage.translate.cacheDesc')}
      >
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={clearCache}>
            {t('settingsPage.translate.clearCache')}
          </SecondaryButton>
          {cacheNote && <span className="text-[11px] text-[var(--text2)]">{cacheNote}</span>}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
