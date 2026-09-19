import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 설치가 끝나면 목록을 다시 읽으라고 알린다 */
  onInstalled: () => void | Promise<void>
}

// 웹스토어 설치 다이얼로그 — 주소나 32자 id 를 받아 메인에 넘긴다.
// 실제 내려받기·압축 해제는 전부 메인에서 일어나고, 여기로는 결과 한 줄만 돌아온다
export function ExtensionWebstoreDialog({
  open,
  onOpenChange,
  onInstalled
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setInput('')
      setError('')
      setBusy(false)
    }
    onOpenChange(next)
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!input.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.samba.extensions.installWebstore(input.trim())
      if (!r.ok) {
        setError(r.error)
        return
      }
      if (r.data.error) {
        setError(r.data.error)
        return
      }
      await onInstalled()
      handleOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('settingsPage.extensions.storeTitle')}</DialogTitle>
          <DialogDescription>{t('settingsPage.extensions.storeDesc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('settingsPage.extensions.storePlaceholder')}
            spellCheck={false}
          />
          {error && <p className="text-[11.5px] leading-snug text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              {t('settingsPage.extensions.cancel')}
            </Button>
            <Button type="submit" disabled={!input.trim() || busy}>
              {busy
                ? t('settingsPage.extensions.installing')
                : t('settingsPage.extensions.storeSubmit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
