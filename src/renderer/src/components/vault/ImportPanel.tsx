import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'
import type { ImportBookmarksResult, ImportPasswordsResult } from '@shared/ipc'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 비밀번호 CSV · 북마크 HTML 가져오기. 결과는 건수 요약만 보여주고
// 값(비밀번호·URL 원문)은 어디에도 노출하지 않는다
export function ImportPanel({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const state = useVaultStore((s) => s.state)
  const importPasswords = useVaultStore((s) => s.importPasswords)
  const importBookmarks = useVaultStore((s) => s.importBookmarks)
  const [busy, setBusy] = useState<'passwords' | 'bookmarks' | null>(null)
  const [passwordResult, setPasswordResult] = useState<ImportPasswordsResult | null>(null)
  const [bookmarkResult, setBookmarkResult] = useState<ImportBookmarksResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const runPasswords = async (): Promise<void> => {
    if (state !== 'unlocked') {
      setErr(t('vault.import.lockedError'))
      return
    }
    setErr(null)
    setBusy('passwords')
    const r = await importPasswords()
    setBusy(null)
    if (r) setPasswordResult(r)
    else setErr(t('vault.import.failed'))
  }

  const runBookmarks = async (): Promise<void> => {
    setErr(null)
    setBusy('bookmarks')
    const r = await importBookmarks()
    setBusy(null)
    if (r) setBookmarkResult(r)
    else setErr(t('vault.import.failed'))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('vault.import.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 overflow-y-auto max-h-[80vh]">
          {/* 가이드 섹션 */}
          <div className="space-y-5">
            {/* 비밀번호 CSV 가이드 */}
            <div className="space-y-2.5">
              <p className="text-[12.5px] font-medium">{t('vault.import.guide.passwordsTitle')}</p>
              <p className="text-[11.5px] text-[var(--text2)]">
                {t('vault.import.guide.passwordsExportSteps')}
              </p>
              <div>
                <p className="text-[11.5px] text-[var(--text2)] mb-1.5">
                  {t('vault.import.guide.passwordsHeadersLabel')}
                </p>
                <code className="block bg-[rgba(0,0,0,.04)] dark:bg-[rgba(255,255,255,.04)] rounded-[8px] p-2 text-[11px] font-mono text-[var(--text)] overflow-x-auto">
                  {t('vault.import.guide.passwordsHeadersExample')}
                </code>
              </div>
              <p className="text-[11.5px] text-[var(--text2)]">
                {t('vault.import.guide.passwordsSupports')}
              </p>
              <p className="text-[11.5px] text-[var(--text2)]">
                {t('vault.import.guide.passwordsWarning')}
              </p>
            </div>

            {/* 북마크 HTML 가이드 */}
            <div className="space-y-2.5">
              <p className="text-[12.5px] font-medium">{t('vault.import.guide.bookmarksTitle')}</p>
              <p className="text-[11.5px] text-[var(--text2)]">
                {t('vault.import.guide.bookmarksExportSteps')}
              </p>
              <p className="text-[11.5px] text-[var(--text2)]">
                {t('vault.import.guide.bookmarksSupports')}
              </p>
            </div>
          </div>

          {/* 버튼 섹션 */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              className="h-9 flex-1 rounded-[9px]"
              onClick={() => void runPasswords()}
            >
              {t('vault.import.passwordsButton')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              className="h-9 flex-1 rounded-[9px]"
              onClick={() => void runBookmarks()}
            >
              {t('vault.import.bookmarksButton')}
            </Button>
          </div>

          {/* 오류 및 결과 섹션 */}
          {err && <p className="text-[12px] text-[#b91c1c]">{err}</p>}
          {passwordResult && (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3.5 py-3 text-[12.5px]">
              <p className="mb-1.5 font-medium">{t('vault.import.passwordsSummaryTitle')}</p>
              <SummaryRow label={t('vault.import.added')} value={passwordResult.added} />
              <SummaryRow label={t('vault.import.updated')} value={passwordResult.updated} />
              <SummaryRow label={t('vault.import.skipped')} value={passwordResult.skipped} />
              <SummaryRow label={t('vault.import.sites')} value={passwordResult.sites} />
              <p className="mt-2 text-[11.5px] text-[var(--text3)]">
                {t('vault.import.deleteCsvHint')}
              </p>
            </div>
          )}
          {bookmarkResult && (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3.5 py-3 text-[12.5px]">
              <p className="mb-1.5 font-medium">{t('vault.import.bookmarksSummaryTitle')}</p>
              <SummaryRow label={t('vault.import.folders')} value={bookmarkResult.folders} />
              <SummaryRow label={t('vault.import.bookmarks')} value={bookmarkResult.bookmarks} />
              <SummaryRow label={t('vault.import.skipped')} value={bookmarkResult.skipped} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SummaryRow({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="flex justify-between text-[var(--text2)]">
      <span>{label}</span>
      <span className="font-medium text-[var(--text)]">{value}</span>
    </div>
  )
}
