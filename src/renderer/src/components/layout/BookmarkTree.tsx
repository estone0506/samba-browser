import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useBookmarkStore } from '@renderer/stores/bookmarkStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { SectionHeader } from './SectionHeader'
import { isSectionOpen } from './sidebar-view'
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
  const { t } = useTranslation()
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
        // 우클릭으로 즉시 삭제하지 않는다 — 삭제는 hover 시 나타나는 × 버튼으로만 한다
        e.preventDefault()
      }}
      style={{ paddingLeft: 10 + depth * 14 }}
      className="group flex w-full items-center gap-2 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5"
    >
      <LetterFavicon title={link.title || link.url} />
      <span className="min-w-0 flex-1 truncate">{link.title || link.url}</span>
      <span
        role="button"
        tabIndex={-1}
        title={t('bookmark.delete')}
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
  const removeFolder = useBookmarkStore((s) => s.removeFolder)
  const isEmpty = folder.folders.length === 0 && folder.links.length === 0
  const hasChildren = folder.folders.length > 0 || folder.links.length > 0

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteTimeoutId, setDeleteTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleDeleteClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!hasChildren) {
      // 하위 항목이 없으면 바로 삭제
      void removeFolder(folder.id)
    } else {
      // 하위 항목이 있으면 2단계 확인
      setConfirmDelete(true)
      // 2초 후 자동 취소
      if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
      const timeoutId = setTimeout(() => {
        setConfirmDelete(false)
        setDeleteTimeoutId(null)
      }, 2000)
      setDeleteTimeoutId(timeoutId)
    }
  }

  const handleConfirmDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
    setConfirmDelete(false)
    setDeleteTimeoutId(null)
    void removeFolder(folder.id)
  }

  const handleCancelDelete = (): void => {
    if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
    setConfirmDelete(false)
    setDeleteTimeoutId(null)
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(folder.id)}
        style={{ paddingLeft: 10 + depth * 14 }}
        className="group flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] font-medium text-[var(--text2)] hover:bg-black/5"
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
        {confirmDelete ? (
          <span
            role="button"
            tabIndex={-1}
            title={t('bookmark.delete')}
            onClick={handleConfirmDelete}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500/20 text-[11px] font-bold text-red-600 hover:bg-red-500/30"
          >
            ○
          </span>
        ) : (
          <span
            role="button"
            tabIndex={-1}
            title={t('bookmark.deleteFolder')}
            onClick={handleDeleteClick}
            className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text3)] hover:bg-black/10 group-hover:flex"
          >
            <X className="h-3 w-3" />
          </span>
        )}
      </button>
      {confirmDelete && (
        <div className="px-2.5 py-1 text-[11px] text-[var(--text3)]">
          <span className="inline-block mr-1.5">{t('bookmark.delete')}?</span>
          <button
            type="button"
            onClick={handleCancelDelete}
            className="text-[11px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:underline"
          >
            {t('confirm.deny')}
          </button>
        </div>
      )}
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
  const setView = useUiStore((s) => s.setView)
  // 섹션 헤더로 접었으면 목록을 그리지 않는다(상태는 설정에 영속)
  const open = useUiStore((s) => isSectionOpen(s.sidebarSections, 'bookmarks'))

  useEffect(() => {
    void load()
  }, [load])

  const isEmpty = !tree || (tree.folders.length === 0 && tree.links.length === 0)
  // 북마크 바(isToolbar) 폴더는 항상 맨 앞에 오도록 안정 정렬한다
  const folders = tree
    ? [...tree.folders].sort((a, b) => (a.isToolbar === b.isToolbar ? 0 : a.isToolbar ? -1 : 1))
    : []

  return (
    <div className={cn('flex flex-col', open && 'min-h-0 flex-1')}>
      <SectionHeader
        sectionKey="bookmarks"
        label={t('bookmark.title')}
        action={
          <button
            type="button"
            onClick={() => setView('bookmarks')}
            className="shrink-0 text-[11px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:underline"
          >
            {t('bookmark.manage')}
          </button>
        }
      />
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {!loading && isEmpty && (
            <div className="px-2.5 py-2 text-[12px] text-[var(--text3)]">
              {t('bookmark.emptyAll')}
            </div>
          )}
          {folders.map((f) => (
            <FolderRow key={f.id} folder={f} depth={0} />
          ))}
          {tree?.links.map((l) => (
            <LinkRow key={l.id} link={l} depth={0} />
          ))}
        </div>
      )}
    </div>
  )
}
