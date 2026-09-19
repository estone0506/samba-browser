import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_SHORTCUTS,
  parseCaptureShortcut,
  type CaptureFormat,
  type CaptureMode
} from '@shared/capture'
import { DEFAULT_CAPTURE_FOLDER_NAME } from '@shared/capture'
import {
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  TextInput,
  type SectionProps
} from './shared'

// 설정 → 일반 "캡처" 카드 — 저장 폴더 · 형식 · 마이크 · 클립보드 · 단축키 표
export function CaptureSettingsCard({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [invalidMode, setInvalidMode] = useState<CaptureMode | null>(null)

  const pickDir = (): void => {
    void window.samba.capture.pickDir().then((r) => {
      // 메인이 설정에 이미 반영했으므로 화면 상태만 맞춰 준다
      if (r.ok && r.data) update({ captureDir: r.data })
    })
  }

  const setShortcut = (mode: CaptureMode, value: string): void => {
    const trimmed = value.trim()
    // 빈 값은 "단축키 없음". 그 밖에는 표기를 해석할 수 있어야 저장한다
    if (trimmed && !parseCaptureShortcut(trimmed)) {
      setInvalidMode(mode)
      return
    }
    setInvalidMode(null)
    update({ captureShortcuts: { ...settings.captureShortcuts, [mode]: trimmed } })
  }

  return (
    <SettingsSection title={t('screenCapture.title')} description={t('screenCapture.settingsDesc')}>
      <SettingsRow label={t('screenCapture.folder')}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-[9px] border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[12px] text-[var(--text2)]">
            {settings.captureDir || `…/${DEFAULT_CAPTURE_FOLDER_NAME}`}
          </div>
          <SecondaryButton onClick={pickDir}>{t('screenCapture.changeFolder')}</SecondaryButton>
        </div>
      </SettingsRow>

      <SettingsRow label={t('screenCapture.format')}>
        <SegmentedGroup<CaptureFormat>
          value={settings.captureFormat}
          onChange={(v) => update({ captureFormat: v })}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'jpg', label: 'JPG' }
          ]}
        />
      </SettingsRow>

      <SettingsToggleRow
        label={t('screenCapture.microphone')}
        description={t('screenCapture.microphoneDesc')}
      >
        <Switch
          checked={settings.captureMicrophone}
          onCheckedChange={(v) => update({ captureMicrophone: v })}
        />
      </SettingsToggleRow>

      <SettingsToggleRow
        label={t('screenCapture.clipboard')}
        description={t('screenCapture.clipboardDesc')}
      >
        <Switch
          checked={settings.captureCopyToClipboard}
          onCheckedChange={(v) => update({ captureCopyToClipboard: v })}
        />
      </SettingsToggleRow>

      <SettingsRow
        label={t('screenCapture.shortcuts')}
        description={t('screenCapture.shortcutsDesc')}
      >
        <div className="flex flex-col gap-1.5">
          {CAPTURE_MODES.map((mode) => (
            <div key={mode} className="flex items-center gap-2">
              <span className="w-[112px] shrink-0 text-[12px] text-[var(--text2)]">
                {t(`screenCapture.modes.${mode}`)}
              </span>
              <TextInput
                value={settings.captureShortcuts[mode]}
                onChange={(v) => setShortcut(mode, v)}
                placeholder={DEFAULT_CAPTURE_SHORTCUTS[mode]}
                invalid={invalidMode === mode}
                className="h-8"
              />
            </div>
          ))}
          {invalidMode && (
            <p className="text-[11px] text-red-500">{t('screenCapture.shortcutInvalid')}</p>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
