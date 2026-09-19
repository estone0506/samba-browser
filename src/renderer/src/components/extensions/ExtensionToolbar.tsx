import { useEffect, useRef } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useExtensionStore } from '@renderer/stores/extensionStore'
import { anchorOf } from './anchor'
import { pinnedExtensions } from './extension-list'

// 주소창 툴바에 고정한 확장들 — 퍼즐 아이콘 왼쪽에 크롬과 같은 순서로 늘어놓는다.
// 아이콘을 누르면 메인이 그 아래에 확장 팝업(chrome-extension:// 문서)을 띄운다
export function ExtensionToolbar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const items = useExtensionStore((s) => s.items)
  const pinned = useExtensionStore((s) => s.pinned)
  const popupFor = useExtensionStore((s) => s.popupFor)
  const load = useExtensionStore((s) => s.load)
  const loadPinned = useExtensionStore((s) => s.loadPinned)
  const runAction = useExtensionStore((s) => s.runAction)
  const popupClosed = useExtensionStore((s) => s.popupClosed)

  // 앱이 뜰 때 한 번 읽고, 설치·제거로 목록이 바뀌면 메인이 알려 줄 때 다시 읽는다
  useEffect(() => {
    void load()
    void loadPinned()
    return window.samba.extensions.onChanged(() => {
      void load()
    })
  }, [load, loadPinned])

  // 팝업이 스스로 닫히면(바깥 클릭·Esc·탭 전환) 버튼 눌림 표시를 되돌린다
  useEffect(() => window.samba.extensions.onPopupClosed(popupClosed), [popupClosed])

  const shown = pinnedExtensions(items, pinned)
  if (shown.length === 0) return null

  return (
    <div className="flex items-center">
      {shown.map((item) => (
        <ExtensionToolbarButton
          key={item.id}
          name={item.name}
          icon={item.icon}
          active={popupFor === item.id}
          title={t('extensions.actionTitle', { name: item.name })}
          onClick={(el) => void runAction(item.id, anchorOf(el))}
        />
      ))}
    </div>
  )
}

function ExtensionToolbarButton({
  name,
  icon,
  active,
  title,
  onClick
}: {
  name: string
  icon?: string
  active: boolean
  title: string
  onClick: (el: HTMLElement) => void
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={() => {
        if (ref.current) onClick(ref.current)
      }}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5',
        active && 'bg-black/5 text-[var(--text)]'
      )}
    >
      {icon ? (
        <img src={icon} alt={name} draggable={false} className="h-4 w-4 object-contain" />
      ) : (
        <Puzzle className="h-4 w-4" />
      )}
    </button>
  )
}
