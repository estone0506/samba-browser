import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import type { VaultAccessPolicy } from '@shared/settings'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

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

// 애플 스타일(흰 카드·얇은 선·검정 기본 버튼)의 키마스터 저장/잠금 정책 설정 패널.
// 값이 바뀔 때마다 즉시 settings.set 으로 반영한다(별도 저장 버튼 없음)
export function VaultSettingsPanel({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [autoLockMinutes, setAutoLockMinutes] = useState(10080)
  const [accessPolicy, setAccessPolicy] = useState<VaultAccessPolicy>('while_unlocked')
  const [autoSubmit, setAutoSubmit] = useState(true)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [excludedHostsText, setExcludedHostsText] = useState('')

  useEffect(() => {
    if (!open) return
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setAutoLockMinutes(r.data.vaultAutoLockMinutes)
      setAccessPolicy(r.data.vaultAccessPolicy)
      setAutoSubmit(r.data.vaultAutoSubmit)
      setRememberDevice(r.data.vaultRememberDevice)
      setExcludedHostsText(r.data.vaultExcludedHosts.join(', '))
    })
  }, [open])

  const chooseAutoLock = (minutes: number): void => {
    setAutoLockMinutes(minutes)
    void window.samba.settings.set({ vaultAutoLockMinutes: minutes })
  }
  const chooseAccessPolicy = (v: VaultAccessPolicy): void => {
    setAccessPolicy(v)
    void window.samba.settings.set({ vaultAccessPolicy: v })
  }
  const toggleAutoSubmit = (v: boolean): void => {
    setAutoSubmit(v)
    void window.samba.settings.set({ vaultAutoSubmit: v })
  }
  const toggleRemember = (v: boolean): void => {
    setRememberDevice(v)
    // 끄면 서비스가 다음 lock/touch 시점에 저장된 기기 키를 즉시 삭제한다(기존 로직)
    void window.samba.settings.set({ vaultRememberDevice: v })
  }
  const commitExcludedHosts = (): void => {
    const hosts = excludedHostsText
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
    void window.samba.settings.set({ vaultExcludedHosts: hosts })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl border border-[var(--line)] bg-white sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('vault.settings.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {/* 자동 잠금 */}
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text)]">
              {t('vault.settings.autoLock')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AUTO_LOCK_OPTIONS.map((o) => (
                <button
                  key={o.minutes}
                  type="button"
                  onClick={() => chooseAutoLock(o.minutes)}
                  className={cn(
                    'h-[28px] rounded-[8px] border px-2.5 text-[12px]',
                    autoLockMinutes === o.minutes
                      ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                      : 'border-[var(--line)] text-[var(--text2)]'
                  )}
                >
                  {t(o.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-[var(--line)]" />

          {/* AI 접근 정책 */}
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text)]">
              {t('vault.settings.accessPolicy')}
            </div>
            <div className="flex flex-col gap-1">
              {ACCESS_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-[9px] border px-2.5 py-2',
                    accessPolicy === o.value
                      ? 'border-[var(--text)] bg-black/[.03]'
                      : 'border-[var(--line)]'
                  )}
                >
                  <input
                    type="radio"
                    name="vault-access-policy"
                    checked={accessPolicy === o.value}
                    onChange={() => chooseAccessPolicy(o.value)}
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
          </div>

          <div className="h-px bg-[var(--line)]" />

          {/* 자동 제출 */}
          <div className="flex items-center justify-between">
            <span>
              <span className="block text-[12.5px] font-medium text-[var(--text)]">
                {t('vault.settings.autoSubmit')}
              </span>
              <span className="block text-[11px] text-[var(--text2)]">
                {t('vault.settings.autoSubmitDesc')}
              </span>
            </span>
            <Switch checked={autoSubmit} onCheckedChange={toggleAutoSubmit} />
          </div>

          {/* 이 PC 에서 기억 */}
          <div className="flex items-center justify-between">
            <span>
              <span className="block text-[12.5px] font-medium text-[var(--text)]">
                {t('vault.settings.remember')}
              </span>
              <span className="block text-[11px] text-[var(--text2)]">
                {t('vault.settings.rememberDesc')}
              </span>
            </span>
            <Switch checked={rememberDevice} onCheckedChange={toggleRemember} />
          </div>

          <div className="h-px bg-[var(--line)]" />

          {/* 제외 도메인 */}
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-[var(--text)]">
              {t('vault.settings.excludedHosts')}
            </div>
            <p className="mb-1.5 text-[11px] text-[var(--text2)]">
              {t('vault.settings.excludedHostsDesc')}
            </p>
            <input
              value={excludedHostsText}
              onChange={(e) => setExcludedHostsText(e.target.value)}
              onBlur={commitExcludedHosts}
              placeholder={t('vault.settings.excludedHostsPlaceholder')}
              className="h-9 w-full rounded-[9px] border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[13px] text-[var(--text)] outline-none"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
