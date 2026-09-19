import type React from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_UI_ZOOM, MIN_UI_ZOOM, type ThemeMode } from '@shared/settings'
import { SegmentedGroup, SettingsRow, SettingsSection, type SectionProps } from './shared'
import { MouseGestureCard } from './MouseGestureCard'

// 화면에 보여 줄 단축키 표(읽기 전용). 값은 번역하지 않는 키 조합 문자열이다
const SHORTCUTS: { keys: string; labelKey: string }[] = [
  { keys: 'Ctrl+T', labelKey: 'settingsPage.appearance.shortcutNewTab' },
  { keys: 'Ctrl+W', labelKey: 'settingsPage.appearance.shortcutCloseTab' },
  { keys: 'Ctrl+L', labelKey: 'settingsPage.appearance.shortcutAddressBar' },
  { keys: 'Ctrl+R', labelKey: 'settingsPage.appearance.shortcutReload' },
  { keys: 'Ctrl+Alt+1~9', labelKey: 'settingsPage.appearance.shortcutWorkspace' }
]

const ZOOM_STEPS = [80, 90, 100, 110, 125, 150]

// 모양 — 테마 · 줌 · 단축키 표.
// 사이드바 구성은 사이드바 자체에서 헤더를 눌러 접고 펴므로 설정에 따로 두지 않는다
export function AppearanceSection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()

  // 설정만 저장하고, 실제 적용은 문서 루트의 data-theme 속성으로 한다
  const chooseTheme = (v: ThemeMode): void => {
    document.documentElement.dataset.theme = v
    update({ theme: v })
  }

  const chooseZoom = (percent: number): void => {
    const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, percent))
    update({ uiZoom: clamped })
  }

  return (
    <>
      <SettingsSection title={t('settingsPage.appearance.themeTitle')}>
        <SegmentedGroup<ThemeMode>
          value={settings.theme}
          onChange={chooseTheme}
          options={[
            { value: 'system', label: t('settingsPage.appearance.themeSystem') },
            { value: 'light', label: t('settingsPage.appearance.themeLight') },
            { value: 'dark', label: t('settingsPage.appearance.themeDark') }
          ]}
        />
      </SettingsSection>

      <SettingsSection title={t('settingsPage.appearance.zoomTitle')}>
        <SettingsRow
          label={t('settingsPage.appearance.zoom', { percent: settings.uiZoom })}
          description={t('settingsPage.appearance.zoomDesc', {
            min: MIN_UI_ZOOM,
            max: MAX_UI_ZOOM
          })}
        >
          <SegmentedGroup<string>
            value={String(settings.uiZoom)}
            onChange={(v) => chooseZoom(Number(v))}
            options={ZOOM_STEPS.map((z) => ({ value: String(z), label: `${z}%` }))}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={t('settingsPage.appearance.shortcutsTitle')}
        description={t('settingsPage.appearance.shortcutsDesc')}
      >
        <div className="flex flex-col">
          {SHORTCUTS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2 text-[12.5px] last:border-b-0"
            >
              <span className="text-[var(--text2)]">{t(s.labelKey)}</span>
              <kbd className="rounded-[6px] border border-[var(--line)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--text)]">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </SettingsSection>
      {/* 마우스 제스처는 화면을 다루는 방식이라 '모양' 에 둔다 */}
      <MouseGestureCard settings={settings} update={update} />
    </>
  )
}
