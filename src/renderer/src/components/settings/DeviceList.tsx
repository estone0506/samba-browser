import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceDto } from '@shared/sync'
import { NotReadyNote, SecondaryButton, StatusBadge } from './shared'

interface Props {
  devices: DeviceDto[]
  loading: boolean
  /** window.samba.devices 가 아직 없는 빌드(Task 9 미병합) */
  unavailable: boolean
  onRevoke: (id: string) => void
}

// 마지막 활동 시각 — 로캘은 i18n 언어를 따르지 않고 브라우저 기본값을 쓴다(표시용)
function formatLastSeen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '-'
  return new Date(ts).toLocaleString()
}

// 로그인한 기기 목록. 원격 로그아웃 버튼은 '이 기기' 에는 붙이지 않는다
export function DeviceList({ devices, loading, unavailable, onRevoke }: Props): React.JSX.Element {
  const { t } = useTranslation()

  if (unavailable) return <NotReadyNote text={t('account.devicesUnavailable')} />
  if (loading)
    return <p className="text-[12px] text-[var(--text2)]">{t('account.devicesLoading')}</p>
  if (devices.length === 0)
    return <p className="text-[12px] text-[var(--text2)]">{t('account.devicesEmpty')}</p>

  return (
    <div className="flex flex-col">
      {devices.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2.5 last:border-b-0"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium text-[var(--text)]">
                {d.name}
              </span>
              {d.isCurrent && <StatusBadge label={t('account.thisDevice')} tone="strong" />}
              {d.revokedAt !== null && (
                <StatusBadge label={t('account.deviceRevoked')} tone="warn" />
              )}
            </div>
            <div className="text-[11px] text-[var(--text2)]">
              {d.os} · v{d.appVersion} · {t('account.lastSeen')} {formatLastSeen(d.lastSeenAt)}
            </div>
          </div>
          {!d.isCurrent && d.revokedAt === null && (
            <SecondaryButton onClick={() => onRevoke(d.id)}>
              {t('account.revokeDevice')}
            </SecondaryButton>
          )}
        </div>
      ))}
    </div>
  )
}
