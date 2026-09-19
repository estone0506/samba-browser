import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { PrimaryButton, SecondaryButton, TextInput } from './shared'
import { normalizeRecoveryKey } from './sections'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'warn' | 'show' | 'confirm' | 'done'

/**
 * 복구 키 재발급 흐름: 경고 → 24자 키 표시(복사/인쇄) → 재입력 확인 → 완료.
 * 키 평문은 화면에 보여 주는 동안만 상태에 있고, 확인이 끝나면 즉시 지운다
 */
export function RecoveryKeyDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('warn')
  const [key, setKey] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = (): void => {
    setStep('warn')
    setKey('')
    setInput('')
    setError(null)
    setBusy(false)
  }

  const close = (v: boolean): void => {
    if (!v) reset()
    onOpenChange(v)
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.samba.vault.recoveryCreate()
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setKey(r.data)
    setStep('show')
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.samba.vault.recoveryConfirm(input.trim())
    setBusy(false)
    if (!r.ok || !r.data) {
      setError(t('recovery.confirmFailed'))
      return
    }
    // 확인이 끝났으므로 평문 키를 상태에서 지운다
    setKey('')
    setInput('')
    setStep('done')
  }

  // 정확히 일치해야만 [완료] 가 켜진다(구분자·대소문자는 무시)
  const matches = key.length > 0 && normalizeRecoveryKey(input) === normalizeRecoveryKey(key)

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-2xl border border-[var(--line)] bg-white sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('recovery.title')}</DialogTitle>
        </DialogHeader>

        {step === 'warn' && (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] text-[var(--text)]">{t('recovery.warnBody')}</p>
            <p className="text-[11.5px] text-[var(--text2)]">{t('recovery.warnDetail')}</p>
            {error && <p className="text-[12px] text-[#b91c1c]">{error}</p>}
            <div className="flex gap-2">
              <PrimaryButton disabled={busy} onClick={() => void create()}>
                {t('recovery.issue')}
              </PrimaryButton>
              <SecondaryButton onClick={() => close(false)}>{t('recovery.cancel')}</SecondaryButton>
            </div>
          </div>
        )}

        {step === 'show' && (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] text-[var(--text)]">{t('recovery.showBody')}</p>
            <code className="select-all rounded-[9px] border border-[var(--line)] bg-black/[.03] px-3 py-2.5 text-center font-mono text-[14px] tracking-wider text-[var(--text)]">
              {key}
            </code>
            <p className="text-[11.5px] text-[var(--text2)]">{t('recovery.showDetail')}</p>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={() => void navigator.clipboard?.writeText(key)}>
                {t('recovery.copy')}
              </SecondaryButton>
              <SecondaryButton onClick={() => window.print()}>
                {t('recovery.print')}
              </SecondaryButton>
              <PrimaryButton onClick={() => setStep('confirm')}>{t('recovery.next')}</PrimaryButton>
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] text-[var(--text)]">{t('recovery.confirmBody')}</p>
            <TextInput
              value={input}
              onChange={setInput}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              invalid={input.length > 0 && !matches}
            />
            {error && <p className="text-[12px] text-[#b91c1c]">{error}</p>}
            <div className="flex gap-2">
              <PrimaryButton disabled={!matches || busy} onClick={() => void confirm()}>
                {t('recovery.done')}
              </PrimaryButton>
              <SecondaryButton onClick={() => setStep('show')}>
                {t('recovery.back')}
              </SecondaryButton>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] text-[var(--text)]">{t('recovery.doneBody')}</p>
            <PrimaryButton onClick={() => close(false)}>{t('recovery.close')}</PrimaryButton>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
