import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chatStore'

export function ConfirmDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const { confirm, reply } = useChatStore()
  return (
    <Dialog open={!!confirm}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('confirm.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-[var(--text2)]">
          {t('confirm.body', { action: confirm?.action ?? '' })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => confirm && reply(confirm.requestId, false)}>
            {t('confirm.deny')}
          </Button>
          <Button onClick={() => confirm && reply(confirm.requestId, true)}>
            {t('confirm.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
