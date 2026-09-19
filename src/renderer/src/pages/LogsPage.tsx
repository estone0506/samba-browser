import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { AuditLogDto } from '@shared/ipc'
import { useVaultStore } from '@renderer/stores/vaultStore'

// 한 번에 보여 줄 기록 수. 더 오래된 것은 계정 상세의 사용 기록에서 본다
const LOG_LIMIT = 300

/**
 * 로그 페이지 — 키마스터 사용 기록을 날짜별로 모아 보여 준다.
 * 어느 계정이 언제 자동 입력됐는지, 값을 봤는지, AI 접근을 허용·거부했는지.
 * 기록 자체는 잠긴 상태에서도 읽히지만(값이 아니라 사건만 저장) 계정 이름은
 * 잠금 해제 뒤에만 붙는다
 */
export function LogsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const state = useVaultStore((s) => s.state)
  const accounts = useVaultStore((s) => s.accounts)
  const loadAccounts = useVaultStore((s) => s.loadAccounts)
  const [logs, setLogs] = useState<AuditLogDto[] | null>(null)

  useEffect(() => {
    if (state === 'unlocked' && accounts.length === 0) void loadAccounts()
  }, [state, accounts.length, loadAccounts])

  useEffect(() => {
    let cancelled = false
    void window.samba.vault.audit(undefined, LOG_LIMIT).then((r) => {
      if (!cancelled) setLogs(r.ok ? r.data : [])
    })
    return () => {
      cancelled = true
    }
  }, [state])

  const accountName = useMemo(() => {
    const map = new Map<number, string>()
    for (const a of accounts) {
      const base = a.label || a.host
      map.set(a.id, a.username ? `${base} · ${a.username}` : base)
    }
    return map
  }, [accounts])

  // 날짜별 묶음(최신이 위)
  const groups = useMemo(() => {
    const out: { day: string; rows: AuditLogDto[] }[] = []
    for (const log of logs ?? []) {
      const day = new Date(log.at).toLocaleDateString(i18n.language, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short'
      })
      const last = out[out.length - 1]
      if (last && last.day === day) last.rows.push(log)
      else out.push({ day, rows: [log] })
    }
    return out
  }, [logs, i18n.language])

  const labelOf = (log: AuditLogDto): string => {
    if (log.accountId === null) return t('logs.global')
    return accountName.get(log.accountId) ?? (state === 'unlocked' ? t('logs.unknownAccount') : '')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 p-6">
        <header>
          <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('logs.title')}</h1>
          <p className="mt-1 text-[11.5px] leading-snug text-[var(--text2)]">{t('logs.desc')}</p>
          {state !== 'unlocked' && (
            <p className="mt-1 text-[11.5px] text-[var(--text3)]">{t('logs.lockedNote')}</p>
          )}
        </header>

        {logs && logs.length === 0 && (
          <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-6 text-center text-[12.5px] text-[var(--text3)]">
            {t('logs.empty')}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.day}>
            <h2 className="mb-1.5 px-1 text-[11.5px] font-medium text-[var(--text2)]">{g.day}</h2>
            <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
              {g.rows.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 border-b border-[var(--line)] px-3.5 py-2 last:border-b-0"
                >
                  <span className="w-[64px] shrink-0 text-[11.5px] tabular-nums text-[var(--text3)]">
                    {new Date(log.at).toLocaleTimeString(i18n.language, {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]">
                    {labelOf(log)}
                  </span>
                  <span className="shrink-0 text-[12.5px] text-[var(--text2)]">
                    {t(`vault.detail.auditAction.${log.action}`)}
                  </span>
                  <span className="shrink-0 rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                    {t(`vault.detail.auditSource.${log.source}`)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
