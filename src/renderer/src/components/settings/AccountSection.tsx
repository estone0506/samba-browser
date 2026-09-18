import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@renderer/stores/authStore'
import { useSyncStore } from '@renderer/stores/syncStore'
import { DeviceList } from './DeviceList'
import {
  NotReadyNote,
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  TextInput
} from './shared'

// 계정 삭제를 활성화하려면 사용자가 그대로 입력해야 하는 확인 문구
const DELETE_CONFIRM_WORD = 'DELETE'

export function AccountSection(): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  const sync = useSyncStore()

  useEffect(() => {
    void auth.load()
    void sync.load()
    const offAuth = auth.subscribe()
    const offSync = sync.subscribe()
    return () => {
      offAuth()
      offSync()
    }
    // 스토어 함수는 zustand 가 고정 참조로 유지하므로 마운트 시 한 번만 붙인다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signedIn = auth.state?.signedIn === true

  useEffect(() => {
    if (signedIn) void auth.loadDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  // .env 미설정이면 로그인 폼 대신 안내 카드를 보여 준다
  if (auth.state && !auth.state.configured) return <NotConfiguredCard />
  if (!auth.state) return <SettingsSection title={t('account.title')}>{null}</SettingsSection>
  if (!signedIn) return <SignInCard />

  return (
    <>
      <SettingsSection title={t('account.title')}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--text)]">
              {auth.state.email ?? '-'}
            </div>
            <div className="text-[11px] text-[var(--text2)]">{t('account.signedIn')}</div>
          </div>
          <StatusBadge
            label={auth.state.plan === 'pro' ? t('account.planPro') : t('account.planFree')}
            tone={auth.state.plan === 'pro' ? 'strong' : 'neutral'}
          />
        </div>
        <SecondaryButton disabled={auth.pending !== null} onClick={() => void auth.signOut()}>
          {t('account.signOut')}
        </SecondaryButton>
      </SettingsSection>

      <SettingsSection title={t('account.devicesTitle')} description={t('account.devicesDesc')}>
        <DeviceList
          devices={auth.devices}
          loading={auth.devicesLoading}
          unavailable={auth.devicesUnavailable}
          onRevoke={(id) => void auth.revokeDevice(id)}
        />
      </SettingsSection>

      <SyncStatusCard />
      <DangerZone />
    </>
  )
}

// .env 가 비어 있을 때 — 로그인 폼 대신 설정 안내
function NotConfiguredCard(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('account.title')} description={t('account.notConfigured')}>
      <p className="text-[12px] text-[var(--text2)]">{t('account.notConfiguredDetail')}</p>
      <code className="w-fit rounded-[8px] bg-black/[.04] px-2 py-1 font-mono text-[11.5px] text-[var(--text)]">
        docs/supabase-설정.md
      </code>
    </SettingsSection>
  )
}

// 미로그인 — 이메일/비밀번호 가입·로그인 + 구글로 계속하기
function SignInCard(): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const busy = auth.pending !== null
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy

  const submit = (): void => {
    if (!canSubmit) return
    if (mode === 'signUp') void auth.signUp(email.trim(), password)
    else void auth.signIn(email.trim(), password)
  }

  // 구글 로그인은 기본 브라우저에서 끝날 때까지 최대 5분 기다린다.
  // IPC 취소 채널이 없으므로 '취소' 는 화면에서 기다리기를 그만두는 것까지만 한다
  if (auth.pending === 'google') {
    return (
      <SettingsSection title={t('account.title')}>
        <p className="text-[12.5px] text-[var(--text)]">{t('account.googleWaiting')}</p>
        <p className="text-[11px] text-[var(--text2)]">{t('account.googleWaitingDetail')}</p>
        <SecondaryButton onClick={() => auth.cancelGoogle()}>
          {t('account.googleCancel')}
        </SecondaryButton>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title={mode === 'signIn' ? t('account.signInTitle') : t('account.signUpTitle')}
      description={t('account.signInDesc')}
    >
      <SettingsRow label={t('account.email')}>
        <TextInput
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
        />
      </SettingsRow>
      <SettingsRow label={t('account.password')}>
        <TextInput
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
        />
      </SettingsRow>
      {auth.error && <p className="text-[12px] text-[#b91c1c]">{auth.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={!canSubmit} onClick={submit}>
          {mode === 'signIn' ? t('account.signIn') : t('account.signUp')}
        </PrimaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            auth.clearError()
            setMode(mode === 'signIn' ? 'signUp' : 'signIn')
          }}
        >
          {mode === 'signIn' ? t('account.toSignUp') : t('account.toSignIn')}
        </SecondaryButton>
      </div>
      <div className="h-px bg-[var(--line)]" />
      <SecondaryButton disabled={busy} onClick={() => void auth.signInGoogle()}>
        {t('account.continueWithGoogle')}
      </SecondaryButton>
    </SettingsSection>
  )
}

// 동기화 상태 — online / pending / lastPulledAt / lastError + 지금 동기화
function SyncStatusCard(): React.JSX.Element {
  const { t } = useTranslation()
  const sync = useSyncStore()
  const status = sync.status

  return (
    <SettingsSection title={t('sync.title')}>
      <div className="flex flex-col gap-1.5 text-[12.5px]">
        <Row
          label={t('sync.connection')}
          value={status?.online ? t('sync.online') : t('sync.offline')}
        />
        <Row label={t('sync.pending')} value={String(status?.pending ?? 0)} />
        <Row
          label={t('sync.lastPulledAt')}
          value={status?.lastPulledAt ? new Date(status.lastPulledAt).toLocaleString() : '-'}
        />
        {status?.lastError && (
          <p className="text-[12px] text-[#b91c1c]">
            {t('sync.lastError')}: {status.lastError}
          </p>
        )}
      </div>
      <PrimaryButton disabled={sync.syncing} onClick={() => void sync.syncNow()}>
        {sync.syncing ? t('sync.syncing') : t('sync.syncNow')}
      </PrimaryButton>
    </SettingsSection>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--text2)]">{label}</span>
      <span className="font-medium text-[var(--text)]">{value}</span>
    </div>
  )
}

// 위험 구역 — 계정 삭제. 확인 문구를 정확히 입력해야만 버튼이 켜진다.
// 실제 삭제 IPC 는 아직 없으므로 눌러도 준비 중 안내만 보여 준다
function DangerZone(): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmText, setConfirmText] = useState('')
  const [notified, setNotified] = useState(false)
  const armed = confirmText === DELETE_CONFIRM_WORD

  return (
    <SettingsSection title={t('account.dangerTitle')} description={t('account.dangerDesc')}>
      <SettingsRow label={t('account.deleteConfirmLabel', { word: DELETE_CONFIRM_WORD })}>
        <TextInput
          value={confirmText}
          onChange={setConfirmText}
          placeholder={DELETE_CONFIRM_WORD}
        />
      </SettingsRow>
      <button
        type="button"
        disabled={!armed}
        onClick={() => setNotified(true)}
        className="h-9 w-fit rounded-[9px] border border-[#b91c1c] px-3 text-[12.5px] font-medium text-[#b91c1c] disabled:opacity-40"
      >
        {t('account.deleteAccount')}
      </button>
      {notified && <NotReadyNote text={t('account.deleteAccountUnavailable')} />}
    </SettingsSection>
  )
}
