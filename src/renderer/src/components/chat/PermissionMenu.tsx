import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Eye, ShieldCheck, Zap } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import type { PermissionMode } from '@shared/settings'

// Aside 의 Permission 메뉴와 같은 개념: 사용 권한 모드 3단계 + 최종 확인 스위치.
// 설정 IPC 로 직접 읽고 쓴다(값이 작아 전용 스토어를 두지 않았다)
const OPTIONS: { mode: PermissionMode; icon: React.ElementType }[] = [
  { mode: 'read_only', icon: Eye },
  { mode: 'guard', icon: ShieldCheck },
  { mode: 'full', icon: Zap }
]

export function PermissionMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<PermissionMode>('guard')
  const [finalConfirm, setFinalConfirm] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setMode(r.data.permissionMode)
      setFinalConfirm(r.data.finalConfirm)
    })
  }, [])

  const choose = (m: PermissionMode): void => {
    setMode(m)
    void window.samba.settings.set({ permissionMode: m })
  }
  const toggleFinalConfirm = (v: boolean): void => {
    setFinalConfirm(v)
    void window.samba.settings.set({ finalConfirm: v })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-white px-2.5 py-1 text-[11px] text-[var(--text2)] transition-colors hover:bg-black/[.03]"
        >
          <ShieldCheck className="h-3 w-3" />
          {t(`permission.${mode === 'read_only' ? 'readOnly' : mode}`)}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="px-2 py-1.5 text-[12px] font-semibold text-[var(--text)]">
          {t('permission.title')}
        </div>
        <div className="flex flex-col gap-0.5">
          {OPTIONS.map(({ mode: m, icon: Icon }) => {
            const key = m === 'read_only' ? 'readOnly' : m
            const selected = mode === m
            return (
              <button
                key={m}
                type="button"
                onClick={() => choose(m)}
                className={cn(
                  'flex items-start gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-black/[.04]',
                  selected && 'bg-black/[.04]'
                )}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text2)]" />
                <span className="flex-1">
                  <span className="block text-[12.5px] font-medium text-[var(--text)]">
                    {t(`permission.${key}`)}
                  </span>
                  <span className="block text-[11px] leading-snug text-[var(--text2)]">
                    {t(`permission.${key}Desc`)}
                  </span>
                </span>
                {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text)]" />}
              </button>
            )
          })}
        </div>
        <div className="my-1.5 h-px bg-[var(--line)]" />
        <div className="flex items-center justify-between rounded-[9px] px-2 py-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text)]">
            {t('permission.finalConfirm')}
          </span>
          <Switch checked={finalConfirm} onCheckedChange={toggleFinalConfirm} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
