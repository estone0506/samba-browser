import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { PhoneToolsProgressDto, PhoneToolsStatusDto } from '@shared/phone'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'

// 폰 연동 프로그램(adb·scrcpy) 설치 카드.
// 사용자는 경로를 적을 필요가 없다 — 버튼 하나로 받아서 풀고 설정까지 저장한다.
// 상태·진행률은 모두 메인이 알려 준 값이고 여기서는 그대로 비춘다

export function ToolsInstallCard({
  onStatus
}: {
  /** 바깥(폰 화면)이 첫 화면 배치를 정할 수 있게 상태를 올려 준다 */
  onStatus?: (status: PhoneToolsStatusDto) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<PhoneToolsStatusDto | null>(null)
  const [progress, setProgress] = useState<PhoneToolsProgressDto | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)

  const apply = useCallback(
    (next: PhoneToolsStatusDto) => {
      setStatus(next)
      onStatus?.(next)
    },
    [onStatus]
  )

  useEffect(() => {
    void (async () => {
      const r = await window.samba.phone.toolsStatus()
      if (r.ok) apply(r.data)
      else setError(r.error)
    })()
  }, [apply])

  useEffect(() => window.samba.phone.onInstallProgress(setProgress), [])

  const install = async (): Promise<void> => {
    setInstalling(true)
    setError(null)
    setProgress(null)
    const r = await window.samba.phone.installTools()
    setInstalling(false)
    setProgress(null)
    if (r.ok) apply(r.data)
    else setError(r.error)
  }

  const installed = status?.installed === true
  const versionLine = [
    status?.adbVersion ? `adb ${status.adbVersion}` : null,
    status?.scrcpyVersion ? `scrcpy ${status.scrcpyVersion}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('phone.tools.title')}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text2)]">
            {t('phone.tools.desc')}
          </p>
          <p className="mt-2 text-[11.5px] text-[var(--text2)]">
            {installing
              ? t('phone.tools.installing')
              : installed
                ? versionLine
                  ? t('phone.tools.installedWith', { versions: versionLine })
                  : t('phone.tools.installed')
                : t('phone.tools.missing')}
          </p>
        </div>
        {installed ? (
          <SecondaryButton disabled={installing} onClick={() => void install()}>
            {t('phone.tools.reinstall')}
          </SecondaryButton>
        ) : (
          <PrimaryButton disabled={installing} onClick={() => void install()}>
            {t('phone.tools.install')}
          </PrimaryButton>
        )}
      </div>

      {installing && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-[var(--text2)]">
            <span>{t(`phone.tools.step.${progress?.step ?? 'platformTools'}`)}</span>
            <span>{progress && progress.percent > 0 ? `${progress.percent}%` : ''}</span>
          </div>
          <div className="h-[6px] overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className="h-full rounded-full bg-[var(--text)] transition-[width] duration-200"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-[10px] border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text2)]">
          <p>{t('phone.tools.failed', { reason: error })}</p>
          <p className="mt-1">{t('phone.tools.manualHint')}</p>
        </div>
      )}

      {/* 안드로이드 쪽 준비 — 접어 둔다(이미 켜 둔 사람이 대부분이다) */}
      <div className="mt-4 border-t border-[var(--line)] pt-3">
        <button
          type="button"
          className="text-[11.5px] text-[var(--text2)] underline"
          aria-expanded={guideOpen}
          onClick={() => setGuideOpen((v) => !v)}
        >
          {guideOpen ? t('phone.tools.guideHide') : t('phone.tools.guideShow')}
        </button>
        {guideOpen && (
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 text-[11.5px] leading-relaxed text-[var(--text2)]">
            <li>{t('phone.tools.guide1')}</li>
            <li>{t('phone.tools.guide2')}</li>
            <li>{t('phone.tools.guide3')}</li>
          </ol>
        )}
      </div>
    </section>
  )
}
