import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'

const MIN_LEN = 8

// 최초 진입: 마스터 비밀번호를 2회 입력받아 금고를 만든다
export function SetupScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const setup = useVaultStore((s) => s.setup)
  const loading = useVaultStore((s) => s.loading)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [remember, setRemember] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setErr(null)
    if (pw1.length < MIN_LEN) {
      setErr(t('vault.setup.tooShort', { n: MIN_LEN }))
      return
    }
    if (pw1 !== pw2) {
      setErr(t('vault.setup.mismatch'))
      return
    }
    const ok = await setup(pw1, remember)
    if (!ok) setErr(t('vault.setup.failed'))
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-8">
      <form onSubmit={submit} className="w-full max-w-[360px] flex flex-col gap-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-white">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div className="text-center">
          <h1 className="text-[19px] font-semibold tracking-tight">{t('vault.setup.title')}</h1>
          <p className="mt-1.5 text-[12.5px] text-[var(--text2)]">{t('vault.setup.desc')}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            data-lpignore="true"
            spellCheck={false}
            placeholder={t('vault.setup.password1')}
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="off"
            data-lpignore="true"
            spellCheck={false}
            placeholder={t('vault.setup.password2')}
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-[12.5px] text-[var(--text2)]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--line)]"
          />
          <span>
            <span className="block">{t('vault.setup.remember')}</span>
            <span className="block text-[11px] text-[var(--text3)]">
              {t('vault.setup.rememberDesc')}
            </span>
          </span>
        </label>
        <div className="rounded-[10px] bg-[rgba(0,0,0,.04)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text2)]">
          {t('vault.setup.warning')}
        </div>
        {err && <p className="text-[12px] text-[#b91c1c]">{err}</p>}
        <Button type="submit" disabled={loading} className="h-9 rounded-[9px]">
          {t('vault.setup.submit')}
        </Button>
      </form>
    </div>
  )
}
