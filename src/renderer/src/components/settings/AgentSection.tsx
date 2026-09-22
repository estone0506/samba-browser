import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import type { PermissionMode } from '@shared/settings'
import { useRecommendStore } from '@renderer/stores/recommendStore'
import { useSiteMemoryStore } from '@renderer/stores/siteMemoryStore'
import { connectionKeyOf } from '@renderer/components/automation/flowgraph-view'
import type { HarnessStatus } from '../../../../main/harness/client'
import {
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  TextInput,
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
  // "연결 확인" 결과. 화면에만 남는 값이라 설정에 저장하지 않는다.
  // ok/fail 둘로만 뭉치지 않고 connectionKeyOf 로 사유(꺼짐·시간초과·엉뚱한 응답·주소 오류)를 구분한다
  const [harnessCheck, setHarnessCheck] = useState<HarnessStatus | 'none'>('none')
  // 주소를 바꾸면 이전 확인 결과는 더 이상 유효하지 않다 — 다시 확인하기 전까지 지운다(리뷰 지적 — Minor 7).
  // 이펙트 대신 렌더 중 비교로 한다(react-hooks/set-state-in-effect 위반 없이 "prop 이 바뀌면
  // 상태 조정" 하는 React 권장 패턴 — VerdictCard 의 후보 버전 초기화와 같은 방식)
  const [checkedUrl, setCheckedUrl] = useState(settings.harnessApiUrl)
  if (checkedUrl !== settings.harnessApiUrl) {
    setCheckedUrl(settings.harnessApiUrl)
    setHarnessCheck('none')
  }
  const clearHistory = useRecommendStore((s) => s.clearHistory)
  const clearActivity = (): void => {
    void clearHistory().then((ok) => setCleared(ok))
  }
  // 사이트 기억 — 호스트별 개수만 받아 온다(경로·메모 본문은 화면으로 오지 않는다)
  const siteMemoryItems = useSiteMemoryStore((s) => s.items)
  const loadSiteMemory = useSiteMemoryStore((s) => s.load)
  const forgetSite = useSiteMemoryStore((s) => s.forget)
  useEffect(() => {
    void loadSiteMemory()
  }, [loadSiteMemory])

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

      <SettingsSection title={t('settingsPage.agent.siteMemoryTitle')}>
        <SettingsToggleRow
          label={t('settingsPage.agent.siteMemory')}
          description={t('settingsPage.agent.siteMemoryDesc')}
        >
          <Switch
            checked={settings.siteMemoryEnabled}
            onCheckedChange={(v) => update({ siteMemoryEnabled: v })}
          />
        </SettingsToggleRow>
        {siteMemoryItems.length === 0 ? (
          <SettingsRow label={t('settingsPage.agent.siteMemoryEmpty')}>{null}</SettingsRow>
        ) : (
          siteMemoryItems.map((item) => (
            <SettingsRow
              key={item.host}
              label={item.host}
              description={t('settingsPage.agent.siteMemoryCounts', {
                recipes: item.recipes,
                notes: item.notes
              })}
            >
              <SecondaryButton onClick={() => void forgetSite(item.host)}>
                {t('settingsPage.agent.siteMemoryForget')}
              </SecondaryButton>
            </SettingsRow>
          ))
        )}
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

      <SettingsSection
        title={t('settingsPage.behavior.bridgeTitle')}
        description={t('settingsPage.behavior.bridgeDesc')}
      >
        <SettingsToggleRow label={t('settingsPage.behavior.bridgeEnabled')}>
          <Switch
            checked={settings.bridgeEnabled}
            onCheckedChange={(v) => update({ bridgeEnabled: v })}
          />
        </SettingsToggleRow>
        <SettingsRow label={t('settingsPage.behavior.bridgePort')}>
          <TextInput
            value={String(settings.bridgePort)}
            onChange={(v) => {
              const n = Number(v.replace(/[^\d]/g, ''))
              if (n >= 1024 && n <= 65535) update({ bridgePort: n })
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('settingsPage.behavior.bridgeToken')}>
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-[12px] text-[var(--text2)]">
              {settings.bridgeToken ? `${settings.bridgeToken.slice(0, 8)}…` : '-'}
            </code>
            <SecondaryButton
              disabled={!settings.bridgeToken}
              onClick={() => void navigator.clipboard.writeText(settings.bridgeToken)}
            >
              {t('settingsPage.behavior.bridgeCopy')}
            </SecondaryButton>
            <SecondaryButton
              onClick={() =>
                void window.samba.bridge
                  .regenerateToken()
                  .then((r) => r.ok && update({ bridgeToken: r.data.token }))
              }
            >
              {t('settingsPage.behavior.bridgeRegenerate')}
            </SecondaryButton>
          </div>
        </SettingsRow>
        <SettingsRow label={t('settingsPage.behavior.harnessUrl')}>
          <div className="flex items-center gap-2">
            <TextInput
              value={settings.harnessApiUrl}
              onChange={(v) => update({ harnessApiUrl: v.trim() })}
            />
            <SecondaryButton
              onClick={() =>
                void window.samba.harness.graph().then((r) => {
                  // IPC 자체가 실패해도(r.ok === false) 사람에게는 "연결 안 됨"과 같은 얘기다
                  setHarnessCheck(r.ok ? r.data.status : 'offline')
                })
              }
            >
              {t('settingsPage.behavior.harnessCheck')}
            </SecondaryButton>
          </div>
        </SettingsRow>
        {harnessCheck !== 'none' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t(connectionKeyOf(harnessCheck))}</p>
        )}
        <p className="text-[11.5px] text-[var(--text2)]">{t('settingsPage.behavior.bridgeHint')}</p>
      </SettingsSection>
    </>
  )
}
