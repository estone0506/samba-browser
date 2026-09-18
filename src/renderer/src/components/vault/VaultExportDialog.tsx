import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import type { ExportFormat } from '@shared/vault'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FORMATS: { value: ExportFormat; labelKey: string; descKey: string }[] = [
  {
    value: 'csv',
    labelKey: 'vault.export.formatCsv',
    descKey: 'vault.export.formatCsvDesc'
  },
  {
    value: 'json',
    labelKey: 'vault.export.formatJson',
    descKey: 'vault.export.formatJsonDesc'
  }
]

// 키마스터 내보내기 — 형식 선택 + 마스터 비밀번호 재입력.
// 평문 경고는 접거나 끌 수 없게 고정으로 노출한다. 실제 파일 쓰기는 전부 메인에서 일어나고
// 여기로는 내보낸 "개수" 와 저장 경로만 돌아온다(값은 절대 오지 않는다)
export function VaultExportDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [master, setMaster] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ itemCount: number; filePath: string } | null>(null)

  // 닫을 때 재입력한 마스터 비밀번호를 렌더러 상태에서 즉시 버린다
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setMaster('')
      setErr(null)
      setDone(null)
      setBusy(false)
    }
    onOpenChange(next)
  }

  const messageFor = (code: string): string => {
    if (code === 'locked') return t('vault.export.lockedError')
    if (code === 'invalid-master') return t('vault.export.invalidMaster')
    if (code === 'cancelled') return t('vault.export.cancelled')
    return t('vault.export.failed')
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (master.length === 0 || busy) return
    setErr(null)
    setDone(null)
    setBusy(true)
    const r = await window.samba.vault.exportVault({ format, master })
    setBusy(false)
    // 성공이든 실패든 재입력 값은 바로 버린다
    setMaster('')
    if (r.ok) setDone(r.data)
    else setErr(messageFor(r.error))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="rounded-2xl border border-[var(--line)] bg-white sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('vault.export.title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* 평문 경고 — 항상 보인다 */}
          <div className="flex items-start gap-2 rounded-[9px] border border-[#fecaca] bg-[#fef2f2] px-2.5 py-2">
            <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[#b91c1c]" />
            <p className="text-[11.5px] leading-snug text-[#b91c1c]">{t('vault.export.warning')}</p>
          </div>

          {/* 형식 선택 */}
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text)]">
              {t('vault.export.format')}
            </div>
            <div className="flex flex-col gap-1">
              {FORMATS.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-[9px] border px-2.5 py-2',
                    format === o.value
                      ? 'border-[var(--text)] bg-black/[.03]'
                      : 'border-[var(--line)]'
                  )}
                >
                  <input
                    type="radio"
                    name="vault-export-format"
                    checked={format === o.value}
                    onChange={() => setFormat(o.value)}
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

          {/* 마스터 비밀번호 재입력 */}
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text)]">
              {t('vault.export.master')}
            </div>
            <Input
              type="password"
              autoComplete="off"
              data-lpignore="true"
              spellCheck={false}
              placeholder={t('vault.export.masterPlaceholder')}
              value={master}
              onChange={(e) => setMaster(e.target.value)}
            />
          </div>

          {err && <p className="text-[12px] text-[#b91c1c]">{err}</p>}
          {done && (
            <p className="text-[12px] text-[var(--text2)]">
              {t('vault.export.done', { count: done.itemCount, path: done.filePath })}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || master.length === 0}
            className="h-9 rounded-[9px]"
          >
            {busy ? t('vault.export.running') : t('vault.export.submit')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
