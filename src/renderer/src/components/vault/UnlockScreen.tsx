import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'

// 잠긴 상태: 마스터 비밀번호 1칸 + 잠금 해제
export function UnlockScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const unlock = useVaultStore((s) => s.unlock)
  const loading = useVaultStore((s) => s.loading)
  const [pw, setPw] = useState('')
  const [remember, setRemember] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setErr(null)
    const ok = await unlock(pw, remember)
    if (!ok) setErr(t('vault.unlock.failed'))
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-8">
      <form onSubmit={submit} className="w-full max-w-[320px] flex flex-col gap-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-white">
          <Lock className="h-6 w-6" />
        </div>
        <div className="text-center">
          <h1 className="text-[19px] font-semibold tracking-tight">{t('vault.unlock.title')}</h1>
          <p className="mt-1.5 text-[12.5px] text-[var(--text2)]">{t('vault.unlock.desc')}</p>
        </div>
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          data-lpignore="true"
          spellCheck={false}
          placeholder={t('vault.unlock.placeholder')}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <label className="flex items-center gap-2 text-[12.5px] text-[var(--text2)]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--line)]"
          />
          {t('vault.setup.remember')}
        </label>
        {err && <p className="text-[12px] text-[#b91c1c]">{err}</p>}
        <Button type="submit" disabled={loading} className="h-9 rounded-[9px]">
          {t('vault.unlock.submit')}
        </Button>
      </form>
    </div>
  )
}
