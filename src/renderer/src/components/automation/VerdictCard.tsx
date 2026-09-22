// 판정 카드 — 하네스의 GET /releases 를 그대로 보인다.
//
// 승인·승격 버튼은 두지 않는다(스펙 §4.4b·§10-4). 승인은 슬랙이나 명령줄에서만 하고,
// 여기서는 그 명령을 복사해 갈 수 있게만 한다
import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { GATE_RULES, parseGateReport, type HarnessReleases } from '@shared/harness'
import { SecondaryButton, StatusBadge } from '@renderer/components/settings/shared'

/** 승인 명령(하네스 저장소에서 실행) */
function approveCommand(version: string): string {
  return `uv run python -m samba_agent.ops.gate --version ${version} --approve`
}

export function VerdictCard({ releases }: { releases: HarnessReleases }): React.JSX.Element {
  const { t } = useTranslation()
  const [showReport, setShowReport] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const report = releases.candidate ? parseGateReport(releases.candidate.report) : null

  // 후보 버전이 바뀌면(새로 저장·판정) 이전 복사 상태가 남아 헷갈리지 않게 초기화한다(리뷰 지적 — Minor 5).
  // 이펙트 대신 렌더 중 비교(React 가 권하는 "prop 이 바뀌면 상태 조정" 패턴)로 한다 —
  // 이펙트 안에서 곧바로 setState 하면 리렌더가 한 번 더 겹친다(react-hooks/set-state-in-effect)
  const candidateVersion = releases.candidate?.version ?? null
  const [prevVersion, setPrevVersion] = useState(candidateVersion)
  if (prevVersion !== candidateVersion) {
    setPrevVersion(candidateVersion)
    setCopyState('idle')
  }

  return (
    <section className="rounded-[9px] border border-[var(--line)] bg-white p-3">
      <h3 className="text-[12px] font-semibold text-[var(--text)]">
        {t('automation.harness.verdict.title')}
      </h3>
      <p className="mt-1 text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.verdict.desc')}
      </p>

      <dl className="mt-2 flex flex-col gap-1 text-[11.5px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="text-[var(--text2)]">{t('automation.harness.verdict.prod')}</dt>
          <dd className="font-mono text-[var(--text)]">
            {releases.current ? releases.current.version : t('automation.harness.verdict.prodNone')}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="text-[var(--text2)]">{t('automation.harness.verdict.candidate')}</dt>
          <dd className="font-mono text-[var(--text)]">
            {releases.candidate
              ? releases.candidate.version
              : t('automation.harness.verdict.candidateNone')}
          </dd>
          {report?.verdict !== null && report !== null && (
            <StatusBadge
              label={t(`automation.harness.verdict.${report.verdict}`)}
              tone={report.verdict === 'promote' ? 'strong' : 'warn'}
            />
          )}
        </div>
      </dl>

      {report !== null && (
        <>
          <p className="mt-2 text-[11px] font-semibold text-[var(--text2)]">
            {t('automation.harness.verdict.checks')}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {GATE_RULES.map((rule) => (
              <li key={rule} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="min-w-0 truncate text-[var(--text)]">
                  {t(`automation.harness.verdict.rule.${rule}`)}
                </span>
                <span
                  className={
                    report.checks[rule] === true
                      ? 'text-[#15803d]'
                      : report.checks[rule] === false
                        ? 'text-[#b91c1c]'
                        : 'text-[var(--text2)]'
                  }
                >
                  {t(
                    report.checks[rule] === true
                      ? 'automation.harness.verdict.pass'
                      : report.checks[rule] === false
                        ? 'automation.harness.verdict.fail'
                        : 'automation.harness.verdict.unknown'
                  )}
                </span>
              </li>
            ))}
          </ul>

          {report.reasons.length > 0 && (
            <>
              <p className="mt-2 text-[11px] font-semibold text-[var(--text2)]">
                {t('automation.harness.verdict.todo')}
              </p>
              <ul className="mt-1 list-disc pl-4 text-[11.5px] text-[var(--text)]">
                {report.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            <SecondaryButton onClick={() => setShowReport(!showReport)}>
              {t(
                showReport
                  ? 'automation.harness.verdict.reportHide'
                  : 'automation.harness.verdict.report'
              )}
            </SecondaryButton>
          </div>
          {showReport && releases.candidate !== null && (
            <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-[9px] border border-[var(--line)] bg-[var(--bg2)] p-2 font-mono text-[11px] text-[var(--text)]">
              {releases.candidate.report}
            </pre>
          )}

          {/* 승인은 앱 밖에서만 한다 — 여기서는 어떻게 하는지 알려 주고 명령만 복사한다 */}
          <div className="mt-2 rounded-[9px] border border-dashed border-[var(--line)] p-2">
            <p className="text-[11.5px] font-semibold text-[var(--text)]">
              {t('automation.harness.verdict.approveTitle')}
            </p>
            <p className="mt-0.5 text-[11.5px] text-[var(--text2)]">
              {t('automation.harness.verdict.approveDesc', {
                version: releases.candidate?.version ?? ''
              })}
            </p>
            <code className="mt-1 block overflow-x-auto whitespace-pre rounded bg-[var(--bg2)] p-1.5 font-mono text-[11px] text-[var(--text)]">
              {approveCommand(releases.candidate?.version ?? '')}
            </code>
            <SecondaryButton
              onClick={() => {
                navigator.clipboard
                  .writeText(approveCommand(releases.candidate?.version ?? ''))
                  .then(() => setCopyState('copied'))
                  .catch(() => setCopyState('failed'))
              }}
            >
              {t(
                copyState === 'copied'
                  ? 'automation.harness.verdict.approveCopied'
                  : copyState === 'failed'
                    ? 'automation.harness.verdict.approveCopyFailed'
                    : 'automation.harness.verdict.approveCopy'
              )}
            </SecondaryButton>
          </div>
        </>
      )}

      {releases.current !== null && (
        <p className="mt-2 truncate text-[11px] text-[var(--text2)]">
          {t('automation.harness.verdict.reportPath', { path: releases.current.report_path })}
        </p>
      )}

      {releases.history.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-[var(--text2)]">
            {t('automation.harness.verdict.history')}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {releases.history.slice(0, 3).map((r) => (
              <li
                key={r.version}
                className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--text)]"
              >
                <span className="min-w-0 truncate font-mono">{r.version}</span>
                <StatusBadge
                  label={t(`automation.harness.verdict.${r.verdict}`)}
                  tone={r.verdict === 'promote' ? 'strong' : 'warn'}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
