import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useBookmarkStore } from '@renderer/stores/bookmarkStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import type { BookmarkFolderDto, BookmarkLinkDto } from '@shared/ipc'

// 즐겨찾기 아이콘 대신 첫 글자를 검정 원에 넣은 파비콘 대체
function LetterFavicon({ title }: { title: string }): React.JSX.Element {
  const letter = title.trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-black/70 text-[8px] font-semibold text-white">
      {letter}
    </span>
  )
}

function LinkRow({ link, depth }: { link: BookmarkLinkDto; depth: number }): React.JSX.Element {
  const remove = useBookmarkStore((s) => s.remove)
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setView = useUiStore((s) => s.setView)

  const open = async (): Promise<void> => {
    setView('browser')
    if (activeTab) {
      await window.samba.tabs.navigate(activeTab.id, link.url)
    } else {
      await window.samba.tabs.create({ url: link.url })
    }
  }

  const onRemove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void remove(link.id)
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      onContextMenu={(e) => {
        e.preventDefault()
        void remove(link.id)
      }}
      style={{ paddingLeft: 10 + depth * 14 }}
      className="group flex w-full items-center gap-2 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5"
    >
      <LetterFavicon title={link.title || link.url} />
      <span className="min-w-0 flex-1 truncate">{link.title || link.url}</span>
      <span
        role="button"
        tabIndex={-1}
        onClick={onRemove}
        className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text3)] hover:bg-black/10 group-hover:flex"
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  )
}

function FolderRow({
  folder,
  depth
}: {
  folder: BookmarkFolderDto
  depth: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const expanded = useBookmarkStore((s) => s.expanded.has(folder.id))
  const toggle = useBookmarkStore((s) => s.toggle)
  const isEmpty = folder.folders.length === 0 && folder.links.length === 0
  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(folder.id)}
        style={{ paddingLeft: 10 + depth * 14 }}
        className="flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] font-medium text-[var(--text2)] hover:bg-black/5"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[var(--text3)] transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
        <span className="min-w-0 flex-1 truncate">
          {folder.isToolbar ? t('bookmark.toolbar') : folder.name}
        </span>
      </button>
      {expanded && (
        <div>
          {isEmpty && (
            <div
              style={{ paddingLeft: 10 + (depth + 1) * 14 }}
              className="py-1 text-[11.5px] text-[var(--text3)]"
            >
              {t('bookmark.empty')}
            </div>
          )}
          {folder.folders.map((f) => (
            <FolderRow key={f.id} folder={f} depth={depth + 1} />
          ))}
          {folder.links.map((l) => (
            <LinkRow key={l.id} link={l} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// 사이드바 메뉴 아래 "북마크" 섹션. 폴더는 접기/펼치기, 링크는 클릭 시 활성 탭에서 열고
// 브라우저 뷰로 전환한다. 섹션 자체가 스크롤되므로 사이드바 푸터(설정)는 항상 보인다
export function BookmarkTree(): React.JSX.Element {
  const { t } = useTranslation()
  const tree = useBookmarkStore((s) => s.tree)
  const loading = useBookmarkStore((s) => s.loading)
  const load = useBookmarkStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  const isEmpty = !tree || (tree.folders.length === 0 && tree.links.length === 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5 pt-3 text-[11px] font-semibold text-[var(--text3)]">
        {t('bookmark.title')}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!loading && isEmpty && (
          <div className="px-2.5 py-2 text-[12px] text-[var(--text3)]">
            {t('bookmark.emptyAll')}
          </div>
        )}
        {tree?.folders.map((f) => (
          <FolderRow key={f.id} folder={f} depth={0} />
        ))}
        {tree?.links.map((l) => (
          <LinkRow key={l.id} link={l} depth={0} />
        ))}
      </div>
    </div>
  )
}
