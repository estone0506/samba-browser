import type React from 'react'
import { cn } from '@renderer/lib/utils'
import type { Settings } from '@shared/settings'

// 설정 화면 전체에서 쓰는 애플 스타일 섹션 카드(흰 배경·얇은 선)
export function SettingsSection({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">{title}</h2>
      {description && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--text2)]">{description}</p>
      )}
      <div className="mt-3 flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-[12.5px] font-medium text-[var(--text)]">{label}</div>
        {description && (
          <div className="text-[11px] leading-snug text-[var(--text2)]">{description}</div>
        )}
      </div>
      {children}
    </div>
  )
}

// 좌우로 라벨과 조작부를 나눠 놓는 줄(스위치용)
export function SettingsToggleRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-[var(--text)]">{label}</span>
        {description && (
          <span className="block text-[11px] leading-snug text-[var(--text2)]">{description}</span>
        )}
      </span>
      {children}
    </div>
  )
}

// 옵션 버튼 그룹(검은 배경 선택 스타일) — 모델·권한모드·새탭주소·검색엔진·언어 공용
export function SegmentedGroup<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'h-[28px] rounded-[8px] border px-2.5 text-[12px]',
            value === o.value
              ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
              : 'border-[var(--line)] text-[var(--text2)]'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// 검정 기본 버튼 / 흰 보조 버튼. 설정 화면 전체에서 같은 높이(36px)를 쓴다
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  type = 'button'
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] bg-[var(--text)] px-3 text-[12.5px] font-medium text-white disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  className,
  type = 'button'
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5 disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

export function TextInput({
  value,
  onChange,
  onBlur,
  placeholder,
  type = 'text',
  invalid,
  className,
  autoComplete
}: {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  type?: 'text' | 'password' | 'email' | 'number'
  invalid?: boolean
  className?: string
  autoComplete?: string
}): React.JSX.Element {
  return (
    <input
      value={value}
      type={type}
      autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className={cn(
        'h-9 w-full rounded-[9px] border bg-[var(--bg)] px-2.5 text-[13px] text-[var(--text)] outline-none',
        invalid ? 'border-red-500' : 'border-[var(--line)]',
        className
      )}
    />
  )
}

// 상태 배지(연결됨·준비 중 등). 브랜드 컬러 없이 회색/검정 계열만 쓴다
export function StatusBadge({
  label,
  tone = 'neutral'
}: {
  label: string
  tone?: 'neutral' | 'strong' | 'warn'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[20px] items-center rounded-full border px-2 text-[11px]',
        tone === 'strong' && 'border-[var(--text)] bg-[var(--text)] font-medium text-white',
        tone === 'warn' && 'border-[#b91c1c] text-[#b91c1c]',
        tone === 'neutral' && 'border-[var(--line)] text-[var(--text2)]'
      )}
    >
      {label}
    </span>
  )
}

// 아직 붙일 IPC 가 없어 화면만 있는 자리에 붙이는 안내 문구
export function NotReadyNote({ text }: { text: string }): React.JSX.Element {
  return (
    <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-2 text-[11.5px] text-[var(--text2)]">
      {text}
    </p>
  )
}

// 각 섹션이 공통으로 받는 props — 현재 설정과 즉시 저장 함수
export interface SectionProps {
  settings: Settings
  update: (patch: Partial<Settings>) => void
}
