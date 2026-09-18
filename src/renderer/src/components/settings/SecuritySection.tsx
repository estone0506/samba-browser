import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import type { VaultAccessPolicy } from '@shared/settings'
import { RecoveryKeyDialog } from './RecoveryKeyDialog'
import {
  SecondaryButton,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  TextInput,
  type SectionProps
} from './shared'

// 자동 잠금 프리셋(분). "안 함" 은 사실상 잠기지 않는 매우 긴 시간(30일)이다
const AUTO_LOCK_OPTIONS: { minutes: number; labelKey: string }[] = [
  { minutes: 15, labelKey: 'vault.settings.autoLock15m' },
  { minutes: 60, labelKey: 'vault.settings.autoLock1h' },
  { minutes: 1440, labelKey: 'vault.settings.autoLock1d' },
  { minutes: 10080, labelKey: 'vault.settings.autoLock1w' },
  { minutes: 43200, labelKey: 'vault.settings.autoLockNever' }
]

const ACCESS_OPTIONS: { value: VaultAccessPolicy; labelKey: string; descKey: string }[] = [
  {
    value: 'always',
    labelKey: 'vault.settings.accessAlways',
    descKey: 'vault.settings.accessAlwaysDesc'
  },
  {
    value: 'while_unlocked',
    labelKey: 'vault.settings.accessWhileUnlocked',
    descKey: 'vault.settings.accessWhileUnlockedDesc'
  },
  {
    value: 'never',
    labelKey: 'vault.settings.accessNever',
    descKey: 'vault.settings.accessNeverDesc'
  }
]

// 보안 — 금고 자동 잠금 · AI 접근 정책 · 자동 제출/갱신 · 제외 도메인 · 복구 키 재발급
export function SecuritySection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [excludedHostsText, setExcludedHostsText] = useState(settings.vaultExcludedHosts.join(', '))
  const [recoveryOpen, setRecoveryOpen] = useState(false)

  const commitExcludedHosts = (): void => {
    const hosts = excludedHostsText
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
    update({ vaultExcludedHosts: hosts })
  }

  return (
    <>
      <SettingsSection title={t('vault.settings.autoLock')}>
        <div className="flex flex-wrap gap-1.5">
          {AUTO_LOCK_OPTIONS.map((o) => (
            <button
              key={o.minutes}
              type="button"
              onClick={() => update({ vaultAutoLockMinutes: o.minutes })}
              className={cn(
                'h-[28px] rounded-[8px] border px-2.5 text-[12px]',
                settings.vaultAutoLockMinutes === o.minutes
                  ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                  : 'border-[var(--line)] text-[var(--text2)]'
              )}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('vault.settings.accessPolicy')}>
        <div className="flex flex-col gap-1">
          {ACCESS_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-[9px] border px-2.5 py-2',
                settings.vaultAccessPolicy === o.value
                  ? 'border-[var(--text)] bg-black/[.03]'
                  : 'border-[var(--line)]'
              )}
            >
              <input
                type="radio"
                name="vault-access-policy"
                checked={settings.vaultAccessPolicy === o.value}
                onChange={() => update({ vaultAccessPolicy: o.value })}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="block text-[12.5px] font-medium text-[var(--text)]">
                  {t(o.labelKey)}
                </span>
                <span className="block text-[11px] leading-snug text-[var(--text2)]">
                  {t(o.descKey)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.security.autofillTitle')}>
        <SettingsToggleRow
          label={t('vault.settings.autoSubmit')}
          description={t('vault.settings.autoSubmitDesc')}
        >
          <Switch
            checked={settings.vaultAutoSubmit}
            onCheckedChange={(v) => update({ vaultAutoSubmit: v })}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          label={t('vault.settings.autoUpdatePassword')}
          description={t('vault.settings.autoUpdatePasswordDesc')}
        >
          <Switch
            checked={settings.vaultAutoUpdatePassword}
            onCheckedChange={(v) => update({ vaultAutoUpdatePassword: v })}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          label={t('vault.settings.remember')}
          description={t('vault.settings.rememberDesc')}
        >
          <Switch
            checked={settings.vaultRememberDevice}
            onCheckedChange={(v) => update({ vaultRememberDevice: v })}
          />
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection title={t('vault.settings.excludedHosts')}>
        <SettingsRow
          label={t('vault.settings.excludedHosts')}
          description={t('vault.settings.excludedHostsDesc')}
        >
          <TextInput
            value={excludedHostsText}
            onChange={setExcludedHostsText}
            onBlur={commitExcludedHosts}
            placeholder={t('vault.settings.excludedHostsPlaceholder')}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t('recovery.sectionTitle')} description={t('recovery.sectionDesc')}>
        <SecondaryButton onClick={() => setRecoveryOpen(true)}>
          {t('recovery.reissue')}
        </SecondaryButton>
      </SettingsSection>

      <RecoveryKeyDialog open={recoveryOpen} onOpenChange={setRecoveryOpen} />
    </>
  )
}
