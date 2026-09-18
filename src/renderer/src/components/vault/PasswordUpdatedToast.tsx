import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'

// 8초 뒤 자동으로 사라진다(토스트 표준 시간). main 의 되돌리기 TTL(60초)보다 짧지만,
// 사라진 뒤에도 되돌리기 토큰 자체는 60초까지 유효하다 — 다만 UI 진입점이 없어질 뿐이다
const AUTO_DISMISS_MS = 8_000

// 로그인 성공 감지로 비밀번호가 자동 갱신됐을 때 뜨는 토스트. CapturePrompt 와 같은 자리(메시지
// 목록 맨 위)에, 같은 애플 스타일로 뜬다. 묻지 않고 이미 갱신된 뒤라 "되돌리기"만 제공한다.
export function PasswordUpdatedToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const passwordUpdated = useVaultStore((s) => s.passwordUpdated)
  const setPasswordUpdated = useVaultStore((s) => s.setPasswordUpdated)
  const undoPasswordUpdate = useVaultStore((s) => s.undoPasswordUpdate)

  useEffect(() => {
    if (!passwordUpdated) return
    const timer = setTimeout(() => setPasswordUpdated(null), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [passwordUpdated, setPasswordUpdated])

  if (!passwordUpdated) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mt-3 mb-1 flex animate-in items-center gap-2.5 rounded-[14px] border border-[var(--line)] bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,.06)] fade-in-0 slide-in-from-top-1 duration-150"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
        <KeyRound className="h-3.5 w-3.5 text-[var(--text)]" />
      </span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--text)]">
        {t('capture.updated', { host: passwordUpdated.host })}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="h-[30px] shrink-0 rounded-[9px] border-[var(--line)] bg-white"
        onClick={undoPasswordUpdate}
      >
        {t('capture.undo')}
      </Button>
    </div>
  )
}
