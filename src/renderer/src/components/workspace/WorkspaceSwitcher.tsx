import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Check, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import type { WorkspaceDto } from '@shared/sync'

// 작업공간 칩에 돌아가며 붙는 색. 사용자가 색을 고르지 않았을 때 순서대로 쓴다
const CHIP_COLORS = ['#8e8e93', '#0071e3', '#34c759', '#ff9500', '#af52de'] as const

function chipColor(w: WorkspaceDto, index: number): string {
  return w.color ?? CHIP_COLORS[index % CHIP_COLORS.length]
}

/** 사이드바 상단의 작업공간 전환기 — 칩 목록 + 새로 만들기 + 우클릭 메뉴 */
export function WorkspaceSwitcher(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { items, switchedNotice, load, create, switchTo, rename, remove, dismissNotice } =
    useWorkspaceStore()
  // 'create' 면 새 작업공간 이름 입력, 숫자면 그 작업공간 이름 변경 중
  const [editing, setEditing] = useState<'create' | number | null>(null)
  const [draft, setDraft] = useState('')
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void load()
    // 단축키(Ctrl+Alt+1~9)로 바뀐 경우에도 메인이 밀어 주는 이벤트로 따라간다
    return window.samba.workspace.onChanged((w) => useWorkspaceStore.getState().applyChanged(w))
  }, [load])

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus()
  }, [editing])

  const closeEditor = (): void => {
    setEditing(null)
    setDraft('')
  }

  const submit = async (): Promise<void> => {
    const name = draft.trim()
    if (!name) return closeEditor()
    if (editing === 'create') await create(name)
    else if (typeof editing === 'number') await rename(editing, name)
    closeEditor()
  }

  // 작업공간이 아직 없으면(첫 로딩 중) 자리를 차지하지 않는다
  if (items.length === 0) return null

  return (
    <div className="px-1 pb-2" onMouseLeave={() => setMenuFor(null)}>
      <div className="flex flex-wrap items-center gap-1">
        {items.map((w, index) => (
          <div key={w.id} className="relative">
            <button
              type="button"
              title={`${w.name} (Ctrl+Alt+${index + 1})`}
              onClick={() => void switchTo(w.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuFor(menuFor === w.id ? null : w.id)
              }}
              className={cn(
                'flex max-w-[112px] cursor-pointer items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]',
                w.isActive
                  ? 'border-black/10 bg-white font-medium shadow-sm'
                  : 'border-transparent text-[var(--text2)] hover:bg-black/5'
              )}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: chipColor(w, index) }}
              />
              <span className="truncate">{w.name}</span>
            </button>
            {menuFor === w.id && (
              <div className="absolute left-0 top-full z-20 mt-1 w-[140px] rounded-xl border border-[var(--line)] bg-white py-1 text-[12px] shadow-lg">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/5"
                  onClick={() => {
                    setMenuFor(null)
                    setDraft(w.name)
                    setEditing(w.id)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5 text-[var(--text2)]" />
                  {t('workspace.rename')}
                </button>
                <button
                  type="button"
                  disabled={items.length <= 1}
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/5 disabled:cursor-default disabled:opacity-40"
                  onClick={() => {
                    setMenuFor(null)
                    void remove(w.id)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-[var(--text2)]" />
                  {t('workspace.delete')}
                </button>
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          title={t('workspace.add')}
          aria-label={t('workspace.add')}
          onClick={() => {
            setDraft('')
            setEditing('create')
          }}
          className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full text-[var(--text2)] hover:bg-black/5"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {editing !== null && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            maxLength={24}
            placeholder={t('workspace.namePlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') closeEditor()
            }}
            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-[11px] outline-none focus:border-black/20"
          />
          <button
            type="button"
            aria-label={t('workspace.save')}
            onClick={() => void submit()}
            className="flex h-[24px] w-[24px] cursor-pointer items-center justify-center rounded-lg bg-black text-white"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {switchedNotice && (
        <button
          type="button"
          onClick={dismissNotice}
          className="mt-1.5 w-full cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-left text-[10px] leading-snug text-[var(--text2)]"
        >
          {t('workspace.switchedNotice')}
        </button>
      )}
    </div>
  )
}
