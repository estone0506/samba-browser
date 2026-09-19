import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'

type Props = Omit<React.ComponentProps<typeof Input>, 'type'>

/**
 * 마스터 비밀번호 입력 칸 — 오른쪽 눈 아이콘으로 입력한 글자를 보였다 숨겼다 한다.
 * 잠금 해제·설정 화면에서 "비밀번호가 올바르지 않아요"가 뜰 때 오타를 확인할 수 있게
 */
export function PasswordInput({ className, ...props }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input {...props} type={show ? 'text' : 'password'} className={cn('pr-9', className)} />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t(show ? 'vault.unlock.hidePassword' : 'vault.unlock.showPassword')}
        title={t(show ? 'vault.unlock.hidePassword' : 'vault.unlock.showPassword')}
        onClick={() => setShow((v) => !v)}
        className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--text3)] hover:text-[var(--text)]"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}
