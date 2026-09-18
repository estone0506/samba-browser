import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { PasswordGenerator } from './PasswordGenerator'
import type { VaultItemType } from '@shared/ipc'

// 메뉴에 노출할 항목 종류. document 는 2단계 이후 지원이라 비활성으로만 보여 준다
const MENU_TYPES: { type: VaultItemType; disabled?: boolean }[] = [
  { type: 'login' },
  { type: 'password' },
  { type: 'card' },
  { type: 'note' },
  { type: 'identity' },
  { type: 'document', disabled: true }
]

interface Props {
  onPick: (type: VaultItemType) => void
  onImport: () => void
  // 아이콘 버튼 크기(목록 상단은 작게, 팝오버는 더 작게)
  compact?: boolean
}

/** 목록 상단 `+` 메뉴 — 항목 종류 · 비밀번호 생성기 · 가져오기 */
export function AddItemMenu({ onPick, onImport, compact = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)

  const pick = (type: VaultItemType): void => {
    setOpen(false)
    setGeneratorOpen(false)
    onPick(type)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setGeneratorOpen(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('vault.add.menu')}
          aria-label={t('vault.add.menu')}
          className={
            compact
              ? 'flex h-[22px] w-[22px] items-center justify-center rounded-[7px] border border-[var(--line)] text-[var(--text2)]'
              : 'flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[var(--line)] text-[var(--text2)]'
          }
        >
          <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px]">
        {MENU_TYPES.map(({ type, disabled }) => (
          <button
            key={type}
            type="button"
            disabled={disabled}
            title={disabled ? t('vault.add.documentDisabled') : undefined}
            onClick={() => pick(type)}
            className="flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-black/5 disabled:cursor-not-allowed disabled:text-[var(--text3)] disabled:hover:bg-transparent"
          >
            {t(`vault.itemType.${type}`)}
          </button>
        ))}
        <div className="my-1 h-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={() => setGeneratorOpen((v) => !v)}
          className="flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-black/5"
        >
          {t('vault.add.generator')}
        </button>
        {generatorOpen && <PasswordGenerator />}
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onImport()
          }}
          className="flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-black/5"
        >
          {t('vault.add.import')}
        </button>
      </PopoverContent>
    </Popover>
  )
}
