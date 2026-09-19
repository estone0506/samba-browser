import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, MoreHorizontal, Pin, Puzzle, Settings, Trash2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useExtensionStore } from '@renderer/stores/extensionStore'
import { useOverlayStore } from '@renderer/stores/overlayStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { ExtensionImportDialog } from './ExtensionImportDialog'
import { anchorOf } from './anchor'
import { sortExtensions, sortWithPinned } from './extension-list'

// 주소창 오른쪽 퍼즐 아이콘 메뉴 — 크롬과 같은 자리, 같은 짜임새다.
// 관리·가져오기 바로가기 아래에 설치된 확장을 늘어놓는다
export function ExtensionMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const setWebviewHidden = useOverlayStore((s) => s.setWebviewHidden)
  const { items, pinned, load, loadPinned, remove, togglePin, runAction } = useExtensionStore()
  const [open, setOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 열려 있는 동안에는 네이티브 웹뷰를 접는다 — 접지 않으면 메뉴가 그 아래로 가려진다
  useEffect(() => {
    setWebviewHidden(open)
    return () => setWebviewHidden(false)
  }, [open, setWebviewHidden])

  // 열 때마다 목록·고정 상태를 다시 읽는다. 그 사이 확장 페이지에서 지웠을 수 있다
  useEffect(() => {
    if (!open) return
    void load()
    void loadPinned()
  }, [open, load, loadPinned])

  // 닫을 때는 안쪽 ⋯ 메뉴도 함께 접는다 — 다음에 열었을 때 남아 있으면 놀란다
  const close = useCallback((): void => {
    setOpen(false)
    setMenuFor(null)
  }, [])

  // 바깥을 누르거나 Esc 를 누르면 닫는다
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  const goManage = (): void => {
    close()
    setView('extensions')
  }

  const shown = sortWithPinned(sortExtensions(items), pinned)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={t('extensions.toolbarTitle')}
        aria-label={t('extensions.toolbarTitle')}
        aria-expanded={open}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5',
          open && 'bg-black/5 text-[var(--text)]'
        )}
      >
        <Puzzle className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute top-[34px] right-0 z-50 flex w-[288px] flex-col rounded-[12px] border border-[var(--line)] bg-white p-1.5 shadow-[0_8px_28px_rgba(0,0,0,.14)]">
          <MenuItem icon={Settings} label={t('extensions.manage')} onClick={goManage} />
          <MenuItem
            icon={Download}
            label={t('extensions.importButton')}
            onClick={() => {
              close()
              setImportOpen(true)
            }}
          />

          <div className="my-1.5 h-px bg-[var(--line)]" />
          <div className="px-2 pb-1 text-[11px] font-medium text-[var(--text2)]">
            {t('extensions.installedTitle')}
          </div>

          {shown.length === 0 ? (
            <p className="px-2 pb-1.5 text-[11.5px] text-[var(--text2)]">
              {t('extensions.menuEmpty')}
            </p>
          ) : (
            <ul className="flex max-h-[280px] flex-col overflow-y-auto">
              {shown.map((item) => (
                <li key={item.id} className="relative">
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-[8px] px-2 py-1.5 hover:bg-black/[.04]',
                      !item.enabled && 'opacity-50'
                    )}
                  >
                    {/* 항목을 누르면 크롬처럼 확장이 실행된다(팝업 또는 옵션 페이지).
                        팝업은 메뉴를 닫은 뒤 퍼즐 아이콘 아래에 붙인다 */}
                    <button
                      type="button"
                      disabled={!item.enabled}
                      onClick={() => {
                        const anchor = rootRef.current ? anchorOf(rootRef.current) : null
                        close()
                        if (anchor) void runAction(item.id, anchor)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                    >
                      {item.icon ? (
                        <img
                          src={item.icon}
                          alt=""
                          draggable={false}
                          className="h-4 w-4 shrink-0 object-contain"
                        />
                      ) : (
                        <Puzzle className="h-4 w-4 shrink-0 text-[var(--text2)]" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]">
                        {item.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void togglePin(item.id)}
                      title={t('extensions.pinned')}
                      aria-label={t('extensions.pinned')}
                      aria-pressed={pinned.includes(item.id)}
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] hover:bg-black/5',
                        pinned.includes(item.id) ? 'text-[var(--text)]' : 'text-[var(--text3)]'
                      )}
                    >
                      <Pin
                        className={cn('h-3.5 w-3.5', pinned.includes(item.id) && 'fill-current')}
                      />
                    </button>
                    {/* 즉시 삭제 — ⋯ 메뉴를 열지 않고 바로 지운다 */}
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null)
                        void remove(item.id)
                      }}
                      title={t('extensions.remove')}
                      aria-label={t('extensions.remove')}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--text3)] hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMenuFor((v) => (v === item.id ? null : item.id))}
                      title={t('extensions.details')}
                      aria-label={t('extensions.details')}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--text2)] hover:bg-black/5"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* ⋯ 메뉴 — 세부정보는 확장 페이지에서 보여 준다 */}
                  {menuFor === item.id && (
                    <div className="absolute top-[30px] right-2 z-10 flex w-[140px] flex-col rounded-[10px] border border-[var(--line)] bg-white p-1 shadow-[0_6px_20px_rgba(0,0,0,.14)]">
                      <MenuItem
                        icon={Settings}
                        label={t('extensions.details')}
                        onClick={goManage}
                      />
                      <MenuItem
                        icon={Trash2}
                        label={t('extensions.remove')}
                        onClick={() => {
                          setMenuFor(null)
                          void remove(item.id)
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ExtensionImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => load()}
      />
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof Puzzle
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/[.04]"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text2)]" />
      {label}
    </button>
  )
}
