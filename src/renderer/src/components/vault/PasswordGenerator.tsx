import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  generatePassword,
  DEFAULT_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type GeneratePasswordOptions
} from '@renderer/lib/password'

interface Props {
  // 생성한 값을 폼에 넣고 싶을 때(비밀번호 필드 옆 생성 버튼). 없으면 복사 버튼만 보인다
  onUse?: (password: string) => void
}

/** 길이·기호 옵션이 있는 비밀번호 생성기 */
export function PasswordGenerator({ onUse }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [length, setLength] = useState(DEFAULT_PASSWORD_LENGTH)
  const [symbols, setSymbols] = useState(true)
  const [digits, setDigits] = useState(true)
  const [value, setValue] = useState(() =>
    generatePassword({ length: DEFAULT_PASSWORD_LENGTH, symbols: true, digits: true })
  )
  const [copied, setCopied] = useState(false)

  const regenerate = (next?: Partial<GeneratePasswordOptions>): void => {
    setValue(
      generatePassword({
        length: next?.length ?? length,
        symbols: next?.symbols ?? symbols,
        digits: next?.digits ?? digits
      })
    )
    setCopied(false)
  }

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }

  return (
    <div className="flex flex-col gap-2.5 p-1">
      <div className="break-all rounded-[10px] border border-[var(--line)] bg-white px-3 py-2 font-mono text-[13px]">
        {value}
      </div>
      <label className="flex items-center gap-2 text-[12px] text-[var(--text2)]">
        <span className="w-10 shrink-0">{t('vault.generator.length')}</span>
        <input
          type="range"
          min={MIN_PASSWORD_LENGTH}
          max={MAX_PASSWORD_LENGTH}
          value={length}
          onChange={(e) => {
            const next = Number(e.target.value)
            setLength(next)
            regenerate({ length: next })
          }}
          className="flex-1"
        />
        <span className="w-6 text-right tabular-nums">{length}</span>
      </label>
      <div className="flex gap-3 text-[12px] text-[var(--text2)]">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={symbols}
            onChange={(e) => {
              setSymbols(e.target.checked)
              regenerate({ symbols: e.target.checked })
            }}
          />
          {t('vault.generator.symbols')}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={digits}
            onChange={(e) => {
              setDigits(e.target.checked)
              regenerate({ digits: e.target.checked })
            }}
          />
          {t('vault.generator.digits')}
        </label>
      </div>
      <div className="flex gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[28px] rounded-[9px]"
          onClick={() => regenerate()}
        >
          {t('vault.generator.generate')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[28px] rounded-[9px]"
          onClick={() => void copy()}
        >
          {copied ? t('vault.generator.copied') : t('vault.generator.copy')}
        </Button>
        {onUse && (
          <Button
            type="button"
            size="sm"
            className="h-[28px] rounded-[9px]"
            onClick={() => onUse(value)}
          >
            {t('vault.generator.use')}
          </Button>
        )}
      </div>
    </div>
  )
}
