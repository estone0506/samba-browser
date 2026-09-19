import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import type { PermissionMode } from '@shared/settings'
import { useRecommendStore } from '@renderer/stores/recommendStore'
import {
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  type SectionProps
} from './shared'

// 에이전트가 연 탭 자동 정리 프리셋(분). 0 은 "정리 안 함"
const CLEANUP_OPTIONS = [0, 5, 15, 30, 60]

// 에이전트 — 완료 알림 · 완료 사운드 · 후속 지시 큐 · 연 탭 자동 정리
export function AgentSection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  // 후속 지시 큐는 아직 저장할 설정 키가 없어 화면 상태로만 둔다(기본 켬)
  const [queueFollowUps, setQueueFollowUps] = useState(true)
  // 활동 기록 지우기 — 한 번 누르면 버튼 문구를 "지웠습니다" 로 바꿔 두 번 누르지 않게 한다
  const [cleared, setCleared] = useState(false)
  const clearHistory = useRecommendStore((s) => s.clearHistory)
  const clearActivity = (): void => {
    void clearHistory().then((ok) => setCleared(ok))
  }

  return (
    <>
      <SettingsSection title={t('settingsPage.agent.notifyTitle')}>
        <SettingsToggleRow
          label={t('settingsPage.agent.notify')}
          description={t('settingsPage.agent.notifyDesc')}
        >
          <Switch
            checked={settings.agentNotify}
            onCheckedChange={(v) => update({ agentNotify: v })}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          label={t('settingsPage.agent.sound')}
          description={t('settingsPage.agent.soundDesc')}
        >
          <Switch
            checked={settings.agentSound}
            onCheckedChange={(v) => update({ agentSound: v })}
          />
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.agent.queueTitle')}>
        <SettingsToggleRow
          label={t('settingsPage.agent.queue')}
          description={t('settingsPage.agent.queueDesc')}
        >
          <Switch checked={queueFollowUps} onCheckedChange={setQueueFollowUps} />
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.ai.permissionMode')}>
        <SettingsRow label={t('settingsPage.ai.permissionMode')}>
          <SegmentedGroup<PermissionMode>
            value={settings.permissionMode}
            onChange={(v) => update({ permissionMode: v })}
            options={[
              { value: 'read_only', label: t('settingsPage.ai.permissionReadOnly') },
              { value: 'guard', label: t('settingsPage.ai.permissionGuard') },
              { value: 'full', label: t('settingsPage.ai.permissionFull') }
            ]}
          />
        </SettingsRow>
        <SettingsToggleRow
          label={t('settingsPage.ai.ocrEnabled')}
          description={t('settingsPage.ai.ocrEnabledDesc')}
        >
          <Switch
            checked={settings.ocrEnabled}
            onCheckedChange={(v) => update({ ocrEnabled: v })}
          />
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.agent.activityTitle')}>
        <SettingsToggleRow
          label={t('settingsPage.agent.activity')}
          description={t('settingsPage.agent.activityDesc')}
        >
          <Switch
            checked={settings.activityRecording}
            onCheckedChange={(v) => update({ activityRecording: v })}
          />
        </SettingsToggleRow>
        <SettingsRow
          label={t('settingsPage.agent.activityClear')}
          description={t('settingsPage.agent.activityClearDesc')}
        >
          <SecondaryButton onClick={clearActivity} disabled={cleared}>
            {t(cleared ? 'settingsPage.agent.activityCleared' : 'settingsPage.agent.activityClear')}
          </SecondaryButton>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t('settingsPage.agent.cleanupTitle')}>
        <SettingsRow
          label={t('settingsPage.agent.cleanup')}
          description={t('settingsPage.agent.cleanupDesc')}
        >
          <SegmentedGroup<string>
            value={String(settings.agentTabCleanupMinutes)}
            onChange={(v) => update({ agentTabCleanupMinutes: Number(v) })}
            options={CLEANUP_OPTIONS.map((m) => ({
              value: String(m),
              label:
                m === 0
                  ? t('settingsPage.agent.cleanupOff')
                  : t('settingsPage.agent.cleanupMinutes', { n: m })
            }))}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
