import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import type { ExtensionInstallResult, ImportBrowserDto } from '@shared/extensions'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 가져오기가 끝나면 목록을 다시 읽으라고 알린다 */
  onImported: () => void | Promise<void>
}

// 다른 브라우저에서 확장 가져오기 — 브라우저별로 묶인 목록에서 체크한 것만 복사한다.
// 원본 폴더를 그대로 쓰지 않고 앱 데이터로 복사하는 이유는 메인 쪽 주석에 적어 두었다
export function ExtensionImportDialog({
  open,
  onOpenChange,
  onImported
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [browsers, setBrowsers] = useState<ImportBrowserDto[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<ExtensionInstallResult[]>([])

  // 열릴 때마다 다시 훑는다 — 그 사이 다른 브라우저에 확장을 깔았을 수 있다.
  // 닫힌 뒤 늦게 도착한 응답은 버린다(cancelled)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const scan = async (): Promise<void> => {
      setScanning(true)
      setError('')
      setFailures([])
      setChecked(new Set())
      try {
        const r = await window.samba.extensions.importSources()
        if (cancelled) return
        if (!r.ok) setError(r.error)
        else setBrowsers(r.data)
      } finally {
        if (!cancelled) setScanning(false)
      }
    }
    void scan()
    return () => {
      cancelled = true
    }
  }, [open])

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (checked.size === 0 || busy) return
    setBusy(true)
    setError('')
    setFailures([])
    try {
      const r = await window.samba.extensions.importFrom([...checked])
      if (!r.ok) {
        setError(r.error)
        return
      }
      await onImported()
      const failed = r.data.filter((x) => x.error)
      if (failed.length > 0) {
        setFailures(failed)
        return
      }
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const empty = !scanning && browsers.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('extensions.importTitle')}</DialogTitle>
          <DialogDescription>{t('extensions.importDesc')}</DialogDescription>
        </DialogHeader>

        {scanning && (
          <p className="text-[12px] text-[var(--text2)]">{t('extensions.importScanning')}</p>
        )}
        {empty && <p className="text-[12px] text-[var(--text2)]">{t('extensions.importEmpty')}</p>}

        <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto">
          {browsers.map((b) => (
            <div key={b.key} className="flex flex-col gap-1">
              <div className="text-[11.5px] font-semibold text-[var(--text2)]">{b.name}</div>
              {b.items.map((item) => (
                <label
                  key={`${b.key}:${item.id}`}
                  className="flex cursor-pointer items-center gap-2 rounded-[9px] px-2 py-1.5 hover:bg-black/5"
                >
                  <input
                    type="checkbox"
                    checked={checked.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  {item.icon ? (
                    <img src={item.icon} alt="" className="h-5 w-5 shrink-0 rounded-[4px]" />
                  ) : (
                    <Puzzle className="h-5 w-5 shrink-0 text-[var(--text2)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]">
                    {item.name}
                    <span className="ml-1.5 text-[11px] text-[var(--text2)]">{item.version}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>

        {error && <p className="text-[11.5px] text-red-500">{error}</p>}
        {failures.length > 0 && (
          <div className="flex flex-col gap-0.5 rounded-[9px] border border-red-200 bg-red-50 px-2.5 py-2">
            <span className="text-[11.5px] font-medium text-red-600">
              {t('extensions.importFailed')}
            </span>
            {failures.map((f) => (
              <span key={f.id} className="text-[11px] leading-snug break-all text-red-500">
                {f.id} — {f.error}
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('extensions.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={checked.size === 0 || busy}>
            {busy
              ? t('extensions.importing')
              : t('extensions.importSubmit', { count: checked.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
