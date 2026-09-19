import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import {
  isDiscordWebhook,
  isSlackWebhook,
  isTelegramChatId,
  isTelegramToken,
  maskSecret,
  type NotifyChannel
} from '@shared/notify'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  TextInput,
  type SectionProps
} from './shared'

// 한 채널의 [테스트 보내기] 결과 문구 상태
type TestState =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'ok' } | { kind: 'fail'; reason: string }

/**
 * 웹훅 주소·봇 토큰 한 칸.
 * 저장된 값은 마스킹해 보여 주고, [변경] 을 눌러야 입력칸이 열린다
 */
function SecretField({
  label,
  placeholder,
  value,
  valid,
  invalidText,
  onSave
}: {
  label: string
  placeholder: string
  value: string
  valid: (v: string) => boolean
  invalidText: string
  onSave: (v: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 저장된 값이 없으면 처음부터 입력칸을 연다
  const [editing, setEditing] = useState(value === '')
  const [draft, setDraft] = useState('')

  if (!editing) {
    return (
      <SettingsRow label={label}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[12.5px] text-[var(--text2)]">
            {maskSecret(value)}
          </span>
          <SecondaryButton
            onClick={() => {
              setDraft('')
              setEditing(true)
            }}
          >
            {t('settingsPage.notify.change')}
          </SecondaryButton>
        </div>
      </SettingsRow>
    )
  }

  const dirty = draft.trim().length > 0
  const ok = valid(draft)
  return (
    <SettingsRow label={label} description={dirty && !ok ? invalidText : undefined}>
      <div className="flex items-center gap-2">
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          type="password"
          autoComplete="off"
          invalid={dirty && !ok}
        />
        <PrimaryButton
          disabled={!ok}
          onClick={() => {
            onSave(draft.trim())
            setDraft('')
            setEditing(false)
          }}
        >
          {t('settingsPage.notify.save')}
        </PrimaryButton>
        {value !== '' && (
          <SecondaryButton onClick={() => setEditing(false)}>
            {t('settingsPage.notify.cancel')}
          </SecondaryButton>
        )}
      </div>
    </SettingsRow>
  )
}

/** 채널 카드 한 장 — 켬/끔 · 입력 · 테스트 보내기 */
function ChannelCard({
  channel,
  title,
  description,
  enabled,
  onToggle,
  ready,
  children
}: {
  channel: NotifyChannel
  title: string
  description: string
  enabled: boolean
  onToggle: (v: boolean) => void
  /** 값이 갖춰져 테스트를 보낼 수 있는가 */
  ready: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  const send = async (): Promise<void> => {
    setTest({ kind: 'sending' })
    const res = await window.samba.notify.test(channel)
    if (!res.ok) {
      setTest({ kind: 'fail', reason: res.error })
      return
    }
    setTest(res.data.ok ? { kind: 'ok' } : { kind: 'fail', reason: res.data.reason })
  }

  return (
    <SettingsSection title={title} description={description}>
      <SettingsToggleRow label={t('settingsPage.notify.use')}>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </SettingsToggleRow>
      {children}
      <div className="flex items-center gap-2">
        <SecondaryButton disabled={!ready || test.kind === 'sending'} onClick={() => void send()}>
          {t('settingsPage.notify.test')}
        </SecondaryButton>
        {test.kind === 'sending' && (
          <span className="text-[11.5px] text-[var(--text2)]">
            {t('settingsPage.notify.testSending')}
          </span>
        )}
        {test.kind === 'ok' && (
          <span className="text-[11.5px] text-[var(--text2)]">
            {t('settingsPage.notify.testSent')}
          </span>
        )}
        {test.kind === 'fail' && (
          <span className="text-[11.5px] text-[#b91c1c]">
            {t('settingsPage.notify.testFailed', { reason: test.reason })}
          </span>
        )}
      </div>
    </SettingsSection>
  )
}

/**
 * 알림 연동 — 자리를 비운 사이에도 폰으로 작업 결과를 받는다.
 * 웹훅 주소·봇 토큰은 이 PC 에만 저장되고 다른 PC 로 동기화되지 않는다
 */
export function NotifySection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <>
      <ChannelCard
        channel="slack"
        title={t('settingsPage.notify.slack')}
        description={t('settingsPage.notify.slackDesc')}
        enabled={settings.notifySlackEnabled}
        onToggle={(v) => update({ notifySlackEnabled: v })}
        ready={isSlackWebhook(settings.notifySlackWebhook)}
      >
        <SecretField
          label={t('settingsPage.notify.webhookUrl')}
          placeholder="https://hooks.slack.com/services/…"
          value={settings.notifySlackWebhook}
          valid={isSlackWebhook}
          invalidText={t('settingsPage.notify.slackInvalid')}
          onSave={(v) => update({ notifySlackWebhook: v })}
        />
      </ChannelCard>

      <ChannelCard
        channel="discord"
        title={t('settingsPage.notify.discord')}
        description={t('settingsPage.notify.discordDesc')}
        enabled={settings.notifyDiscordEnabled}
        onToggle={(v) => update({ notifyDiscordEnabled: v })}
        ready={isDiscordWebhook(settings.notifyDiscordWebhook)}
      >
        <SecretField
          label={t('settingsPage.notify.webhookUrl')}
          placeholder="https://discord.com/api/webhooks/…"
          value={settings.notifyDiscordWebhook}
          valid={isDiscordWebhook}
          invalidText={t('settingsPage.notify.discordInvalid')}
          onSave={(v) => update({ notifyDiscordWebhook: v })}
        />
      </ChannelCard>

      <ChannelCard
        channel="telegram"
        title={t('settingsPage.notify.telegram')}
        description={t('settingsPage.notify.telegramDesc')}
        enabled={settings.notifyTelegramEnabled}
        onToggle={(v) => update({ notifyTelegramEnabled: v })}
        ready={
          isTelegramToken(settings.notifyTelegramToken) &&
          isTelegramChatId(settings.notifyTelegramChatId)
        }
      >
        <SecretField
          label={t('settingsPage.notify.botToken')}
          placeholder="123456789:AA…"
          value={settings.notifyTelegramToken}
          valid={isTelegramToken}
          invalidText={t('settingsPage.notify.telegramTokenInvalid')}
          onSave={(v) => update({ notifyTelegramToken: v })}
        />
        <SecretField
          label={t('settingsPage.notify.chatId')}
          placeholder="123456789"
          value={settings.notifyTelegramChatId}
          valid={isTelegramChatId}
          invalidText={t('settingsPage.notify.chatIdInvalid')}
          onSave={(v) => update({ notifyTelegramChatId: v })}
        />
      </ChannelCard>

      <SettingsSection
        title={t('settingsPage.notify.eventsTitle')}
        description={t('settingsPage.notify.eventsDesc')}
      >
        <SettingsToggleRow label={t('settingsPage.notify.onDone')}>
          <Switch
            checked={settings.notifyOnDone}
            onCheckedChange={(v) => update({ notifyOnDone: v })}
          />
        </SettingsToggleRow>
        <SettingsToggleRow label={t('settingsPage.notify.onFailed')}>
          <Switch
            checked={settings.notifyOnFailed}
            onCheckedChange={(v) => update({ notifyOnFailed: v })}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          label={t('settingsPage.notify.onAttention')}
          description={t('settingsPage.notify.onAttentionDesc')}
        >
          <Switch
            checked={settings.notifyOnAttention}
            onCheckedChange={(v) => update({ notifyOnAttention: v })}
          />
        </SettingsToggleRow>
      </SettingsSection>
    </>
  )
}
