import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chatStore'
import { AGENT_EFFORTS, type AgentEffort } from '@shared/settings'

// Aside 의 입력줄 아래 "Fable 5.1 High ▾" 와 같은 자리.
// 왼쪽은 모델(설정의 작업별 모델 '표준' 칸), 오른쪽은 추론 강도다

function OptionRow({
  label,
  desc,
  selected,
  onClick
}: {
  label: string
  desc?: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-black/[.04]',
        selected && 'bg-black/[.04]'
      )}
    >
      <span className="flex-1">
        <span className="block truncate text-[12.5px] font-medium text-[var(--text)]">{label}</span>
        {desc && <span className="block text-[11px] leading-snug text-[var(--text2)]">{desc}</span>}
      </span>
      {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text)]" />}
    </button>
  )
}

export function ModelEffortMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const model = useChatStore((s) => s.model)
  const modelChoices = useChatStore((s) => s.modelChoices)
  const effort = useChatStore((s) => s.effort)
  const load = useChatStore((s) => s.loadModelMenu)
  const setModel = useChatStore((s) => s.setModel)
  const setEffort = useChatStore((s) => s.setEffort)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  // 사용자가 설정 화면에서 직접 적어 넣은 모델도 목록에 보이게 한다
  const choices = modelChoices.includes(model) ? modelChoices : [model, ...modelChoices]

  const choose = (m: string): void => {
    setModelOpen(false)
    void setModel(m)
  }
  const chooseEffort = (e: AgentEffort): void => {
    setEffortOpen(false)
    void setEffort(e)
  }

  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-[var(--line)] bg-white text-[11px] text-[var(--text2)]">
      <Popover open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t('chat.modelMenu')}
            className="min-w-0 rounded-l-full px-2.5 py-1 transition-colors hover:bg-black/[.03]"
          >
            <span className="block max-w-[140px] truncate">{model}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="px-2 py-1.5 text-[12px] font-semibold text-[var(--text)]">
            {t('chat.modelMenu')}
          </div>
          <div className="flex flex-col gap-0.5">
            {choices.map((m) => (
              <OptionRow key={m} label={m} selected={m === model} onClick={() => choose(m)} />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <span aria-hidden className="text-[var(--text3)]">
        ·
      </span>
      <Popover open={effortOpen} onOpenChange={setEffortOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t('chat.effortMenu')}
            className="inline-flex items-center gap-1 rounded-r-full px-2.5 py-1 transition-colors hover:bg-black/[.03]"
          >
            {t(`chat.effort.${effort}`)}
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="px-2 py-1.5 text-[12px] font-semibold text-[var(--text)]">
            {t('chat.effortMenu')}
          </div>
          <div className="flex flex-col gap-0.5">
            {AGENT_EFFORTS.map((e) => (
              <OptionRow
                key={e}
                label={t(`chat.effort.${e}`)}
                desc={t(`chat.effortDesc.${e}`)}
                selected={e === effort}
                onClick={() => chooseEffort(e)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
