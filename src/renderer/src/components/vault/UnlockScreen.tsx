import { useEffect, useState } from 'react'
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
  // 체크박스를 건드리지 않았으면 설정을 저장하지 않는 경로(기존 값 유지)
  const unlockOnly = useVaultStore((s) => s.unlockOnly)
  const loading = useVaultStore((s) => s.loading)
  const [pw, setPw] = useState('')
  // 저장된 설정을 읽어 오기 전까지는 기본값(true)을 보여주고, 읽어 온 뒤 실제 값으로 맞춘다.
  // 예전에는 항상 false 로 시작해서, 잠금 해제만 해도 "이 PC 에서 기억" 이 꺼져버렸다
  const [remember, setRemember] = useState(true)
  const [savedRemember, setSavedRemember] = useState<boolean | null>(null)
  // 사용자가 체크박스를 직접 건드렸는지 — settings.get() 응답이 아직 안 왔어도
  // (savedRemember 가 null 이어도) 방금 바꾼 값을 무시하지 않기 위해 따로 추적한다
  const [rememberTouched, setRememberTouched] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 이 금고가 다른 PC 에서 내려온 키 재료로 만들어졌는가 — 안내 문구만 달라진다
  const [fromSync, setFromSync] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.samba.settings.get().then((r) => {
      if (cancelled || !r.ok) return
      setRemember(r.data.vaultRememberDevice)
      setSavedRemember(r.data.vaultRememberDevice)
    })
    void window.samba.vault.keyFromSync().then((r) => {
      if (cancelled || !r.ok) return
      setFromSync(r.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setErr(null)
    // 체크 상태가 그대로면 settings 를 건드리지 않는다. 사용자가 방금 체크박스를 바꿨다면
    // settings.get() 응답이 아직 안 왔더라도(savedRemember === null) 항상 반영한다
    const changed = rememberTouched || (savedRemember !== null && remember !== savedRemember)
    const ok = changed ? await unlock(pw, remember) : await unlockOnly(pw)
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
          <p className="mt-1.5 text-[12.5px] text-[var(--text2)]">
            {t(fromSync ? 'vault.unlock.fromSync' : 'vault.unlock.desc')}
          </p>
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
            onChange={(e) => {
              setRemember(e.target.checked)
              setRememberTouched(true)
            }}
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
