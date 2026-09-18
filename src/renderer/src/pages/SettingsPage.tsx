import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { VaultSettingsPanel } from '@renderer/components/vault/VaultSettingsPanel'
import { isHttpUrl, isInternalUrl } from '@shared/url'
import type { NewTabUrlMode, PermissionMode, SearchEngine, Settings } from '@shared/settings'

// 설정 페이지 전체에서 쓰는 애플 스타일 섹션 카드(흰 배경·얇은 선)
function SettingsSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <h2 className="mb-3 text-[13px] font-semibold text-[var(--text)]">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function SettingsRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-[12.5px] font-medium text-[var(--text)]">{label}</div>
        {description && (
          <div className="text-[11px] leading-snug text-[var(--text2)]">{description}</div>
        )}
      </div>
      {children}
    </div>
  )
}

// 옵션 버튼 그룹(검은 배경 선택 스타일) — 모델·권한모드·새탭주소·검색엔진·언어 공용
function SegmentedGroup<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'h-[28px] rounded-[8px] border px-2.5 text-[12px]',
            value === o.value
              ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
              : 'border-[var(--line)] text-[var(--text2)]'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// 설정 페이지 — 브라우저 / AI / 키마스터 섹션. 애플 스타일(흰 카드·얇은 선·검정 기본 버튼).
// 모든 변경은 저장 버튼 없이 즉시 window.samba.settings.set 으로 반영한다(VaultSettingsPanel 과 동일 패턴)
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [homeUrlText, setHomeUrlText] = useState('')
  const [homeUrlError, setHomeUrlError] = useState(false)
  const [newTabUrl, setNewTabUrl] = useState<NewTabUrlMode>('home')
  const [searchEngine, setSearchEngine] = useState<SearchEngine>('google')
  const [language, setLanguage] = useState<'ko' | 'en'>('ko')
  const [model, setModel] = useState<Settings['model']>('sonnet')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('guard')
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setHomeUrlText(r.data.homeUrl)
      setNewTabUrl(r.data.newTabUrl)
      setSearchEngine(r.data.searchEngine)
      setLanguage(r.data.language)
      setModel(r.data.model)
      setPermissionMode(r.data.permissionMode)
      setLoaded(true)
    })
  }, [])

  const commitHomeUrl = (): void => {
    const value = homeUrlText.trim()
    if (!isHttpUrl(value) && !isInternalUrl(value)) {
      setHomeUrlError(true)
      return
    }
    setHomeUrlError(false)
    void window.samba.settings.set({ homeUrl: value })
  }

  const chooseNewTabUrl = (v: NewTabUrlMode): void => {
    setNewTabUrl(v)
    void window.samba.settings.set({ newTabUrl: v })
  }
  const chooseSearchEngine = (v: SearchEngine): void => {
    setSearchEngine(v)
    void window.samba.settings.set({ searchEngine: v })
  }
  const chooseLanguage = (v: 'ko' | 'en'): void => {
    setLanguage(v)
    void i18n.changeLanguage(v)
    void window.samba.settings.set({ language: v })
  }
  const chooseModel = (v: Settings['model']): void => {
    setModel(v)
    void window.samba.settings.set({ model: v })
  }
  const choosePermissionMode = (v: PermissionMode): void => {
    setPermissionMode(v)
    void window.samba.settings.set({ permissionMode: v })
  }

  if (!loaded) return <div className="flex min-h-0 flex-1" />

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4 p-6">
        <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('settingsPage.title')}</h1>

        {/* 브라우저 */}
        <SettingsSection title={t('settingsPage.browser.title')}>
          <SettingsRow label={t('settingsPage.browser.homeUrl')}>
            <div className="flex items-center gap-2">
              <input
                value={homeUrlText}
                onChange={(e) => {
                  setHomeUrlText(e.target.value)
                  setHomeUrlError(false)
                }}
                onBlur={commitHomeUrl}
                placeholder="https://"
                className={cn(
                  'h-9 flex-1 rounded-[9px] border bg-[var(--bg)] px-2.5 text-[13px] text-[var(--text)] outline-none',
                  homeUrlError ? 'border-red-500' : 'border-[var(--line)]'
                )}
              />
              <button
                type="button"
                onClick={commitHomeUrl}
                className="h-9 rounded-[9px] bg-[var(--text)] px-3 text-[12.5px] font-medium text-white"
              >
                {t('settingsPage.browser.save')}
              </button>
            </div>
            {homeUrlError && (
              <p className="text-[11px] text-red-500">{t('settingsPage.browser.homeUrlError')}</p>
            )}
          </SettingsRow>

          <SettingsRow label={t('settingsPage.browser.newTabUrl')}>
            <SegmentedGroup
              value={newTabUrl}
              onChange={chooseNewTabUrl}
              options={[
                { value: 'home', label: t('settingsPage.browser.newTabUrlHome') },
                { value: 'blank', label: t('settingsPage.browser.newTabUrlBlank') }
              ]}
            />
          </SettingsRow>

          <SettingsRow label={t('settingsPage.browser.searchEngine')}>
            <SegmentedGroup
              value={searchEngine}
              onChange={chooseSearchEngine}
              options={[
                { value: 'google', label: t('settingsPage.browser.searchEngineGoogle') },
                { value: 'naver', label: t('settingsPage.browser.searchEngineNaver') }
              ]}
            />
          </SettingsRow>

          <SettingsRow label={t('settingsPage.browser.language')}>
            <SegmentedGroup
              value={language}
              onChange={chooseLanguage}
              options={[
                { value: 'ko', label: t('settingsPage.browser.languageKo') },
                { value: 'en', label: t('settingsPage.browser.languageEn') }
              ]}
            />
          </SettingsRow>
        </SettingsSection>

        {/* AI */}
        <SettingsSection title={t('settingsPage.ai.title')}>
          <SettingsRow label={t('settingsPage.ai.model')}>
            <SegmentedGroup
              value={model}
              onChange={chooseModel}
              options={[
                { value: 'sonnet', label: 'Sonnet' },
                { value: 'opus', label: 'Opus' },
                { value: 'haiku', label: 'Haiku' }
              ]}
            />
          </SettingsRow>

          <SettingsRow label={t('settingsPage.ai.permissionMode')}>
            <SegmentedGroup
              value={permissionMode}
              onChange={choosePermissionMode}
              options={[
                { value: 'read_only', label: t('settingsPage.ai.permissionReadOnly') },
                { value: 'guard', label: t('settingsPage.ai.permissionGuard') },
                { value: 'full', label: t('settingsPage.ai.permissionFull') }
              ]}
            />
          </SettingsRow>
        </SettingsSection>

        {/* 키마스터 */}
        <SettingsSection title={t('settingsPage.vault.title')}>
          <SettingsRow
            label={t('settingsPage.vault.description')}
            description={t('settingsPage.vault.descriptionDetail')}
          >
            <button
              type="button"
              onClick={() => setVaultSettingsOpen(true)}
              className="h-9 w-fit rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5"
            >
              {t('settingsPage.vault.open')}
            </button>
          </SettingsRow>
        </SettingsSection>
      </div>

      <VaultSettingsPanel open={vaultSettingsOpen} onOpenChange={setVaultSettingsOpen} />
    </div>
  )
}
