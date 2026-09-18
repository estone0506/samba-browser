import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Folder,
  MoreVertical,
  Plus,
  FolderPlus,
  Search,
  Upload,
  Download,
  ArrowDownAZ
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useBookmarkStore } from '@renderer/stores/bookmarkStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import type { BookmarkFolderDto, BookmarkLinkDto, BookmarkTreeDto } from '@shared/ipc'

// 왼쪽 폴더 트리에서 고르는 대상. 'other' 는 크롬처럼 "기타 북마크"(북마크 바 제외한 루트)를 뜻한다
type SelectedFolder =
  { kind: 'toolbar'; id: number } | { kind: 'other' } | { kind: 'folder'; id: number }

interface FlatFolder {
  id: number
  label: string
  depth: number
}

function findFolder(folders: BookmarkFolderDto[], id: number): BookmarkFolderDto | undefined {
  for (const f of folders) {
    if (f.id === id) return f
    const sub = findFolder(f.folders, id)
    if (sub) return sub
  }
  return undefined
}

// 폴더 선택 다이얼로그용 — 전체 폴더를 깊이 우선으로 평탄화한다
function flattenFolders(
  folders: BookmarkFolderDto[],
  depth: number,
  toolbarLabel: string
): FlatFolder[] {
  const rows: FlatFolder[] = []
  for (const f of folders) {
    rows.push({ id: f.id, label: f.isToolbar ? toolbarLabel : f.name, depth })
    rows.push(...flattenFolders(f.folders, depth + 1, toolbarLabel))
  }
  return rows
}

// folder 자신과 모든 하위 폴더의 id 를 모은다(이동 대상 목록에서 제외할 때 씀)
function collectFolderIds(folder: BookmarkFolderDto): number[] {
  return [folder.id, ...folder.folders.flatMap(collectFolderIds)]
}

// 검색어와 제목/URL 부분일치하는 링크를 트리 전체에서 모은다
function searchLinks(tree: BookmarkTreeDto, query: string): BookmarkLinkDto[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const result: BookmarkLinkDto[] = []
  const walk = (folders: BookmarkFolderDto[], links: BookmarkLinkDto[]): void => {
    for (const l of links) {
      if (l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q)) result.push(l)
    }
    for (const f of folders) walk(f.folders, f.links)
  }
  walk(tree.folders, tree.links)
  return result
}

function FolderIcon(): React.JSX.Element {
  return <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
}

function LetterFavicon({ title }: { title: string }): React.JSX.Element {
  const letter = title.trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/70 text-[9px] font-semibold text-white">
      {letter}
    </span>
  )
}

// 왼쪽 트리의 폴더 한 줄 (재귀). 링크는 여기 표시하지 않는다(가운데 목록 전용)
function TreeFolderRow({
  folder,
  depth,
  selected,
  selectedId,
  expanded,
  onToggle,
  onSelect
}: {
  folder: BookmarkFolderDto
  depth: number
  selected: SelectedFolder
  selectedId: number | undefined
  expanded: Set<number>
  onToggle: (id: number) => void
  onSelect: (s: SelectedFolder) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const isOpen = expanded.has(folder.id)
  const isSelected =
    (selected.kind === 'toolbar' || selected.kind === 'folder') && selectedId === folder.id
  const hasSubfolders = folder.folders.length > 0
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          onSelect(
            folder.isToolbar
              ? { kind: 'toolbar', id: folder.id }
              : { kind: 'folder', id: folder.id }
          )
        }
        style={{ paddingLeft: 10 + depth * 14 }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px]',
          isSelected
            ? 'bg-black/[.06] font-medium text-[var(--text)]'
            : 'text-[var(--text2)] hover:bg-black/5'
        )}
      >
        <ChevronRight
          onClick={(e) => {
            if (!hasSubfolders) return
            e.stopPropagation()
            onToggle(folder.id)
          }}
          className={cn(
            'h-3 w-3 shrink-0 text-[var(--text3)] transition-transform',
            !hasSubfolders && 'opacity-0',
            isOpen && 'rotate-90'
          )}
        />
        <FolderIcon />
        <span className="min-w-0 flex-1 truncate">
          {folder.isToolbar ? t('bookmarksPage.toolbarFolder') : folder.name}
        </span>
      </button>
      {isOpen &&
        folder.folders.map((f) => (
          <TreeFolderRow
            key={f.id}
            folder={f}
            depth={depth + 1}
            selected={selected}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  )
}

// 가운데 목록의 폴더/링크 한 줄
function ContentRow({
  icon,
  name,
  url,
  onOpen,
  onRename,
  onMove,
  onDelete
}: {
  icon: React.ReactNode
  name: string
  url?: string
  onOpen: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="group flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 hover:bg-black/[.03]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {icon}
        <span className="min-w-0 shrink-0 truncate text-[13px] text-[var(--text)]">{name}</span>
        {url && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text3)]">{url}</span>
        )}
      </button>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text3)] opacity-0 hover:bg-black/10 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40">
          <MenuItem
            label={t('bookmarksPage.menu.open')}
            onClick={() => {
              setMenuOpen(false)
              onOpen()
            }}
          />
          <MenuItem
            label={t('bookmarksPage.menu.rename')}
            onClick={() => {
              setMenuOpen(false)
              onRename()
            }}
          />
          <MenuItem
            label={t('bookmarksPage.menu.move')}
            onClick={() => {
              setMenuOpen(false)
              onMove()
            }}
          />
          <MenuItem
            label={t('bookmarksPage.menu.delete')}
            danger
            onClick={() => {
              setMenuOpen(false)
              onDelete()
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger
}: {
  label: string
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-black/5',
        danger ? 'text-[#b91c1c]' : 'text-[var(--text)]'
      )}
    >
      {label}
    </button>
  )
}

type DialogState =
  | { kind: 'addFolder'; parentId: number | null }
  | { kind: 'addLink'; folderId: number | null }
  | { kind: 'rename'; id: number; kind2: 'folder' | 'link'; name: string }
  | { kind: 'move'; id: number; kind2: 'folder' | 'link' }
  | null

// 북마크 관리자 페이지 — 크롬/Aside 북마크 관리자와 동일한 구조.
// 왼쪽 폴더 트리(북마크 바 / 기타 북마크) · 가운데 현재 폴더 목록 · 상단 검색 · 우상단 메뉴
export function BookmarksPage(): React.JSX.Element {
  const { t } = useTranslation()
  const tree = useBookmarkStore((s) => s.tree)
  const load = useBookmarkStore((s) => s.load)
  const createFolder = useBookmarkStore((s) => s.createFolder)
  const createLink = useBookmarkStore((s) => s.createLink)
  const rename = useBookmarkStore((s) => s.rename)
  const move = useBookmarkStore((s) => s.move)
  const removeFolder = useBookmarkStore((s) => s.removeFolder)
  const removeLink = useBookmarkStore((s) => s.remove)
  const sort = useBookmarkStore((s) => s.sort)
  const exportBookmarks = useBookmarkStore((s) => s.exportBookmarks)
  const importBookmarksVault = useVaultStore((s) => s.importBookmarks)

  const [selected, setSelected] = useState<SelectedFolder>({ kind: 'other' })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')
  const [topMenuOpen, setTopMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [formValue, setFormValue] = useState({ name: '', url: '' })
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const toolbarFolder = tree?.folders.find((f) => f.isToolbar)
  const otherRootFolders = tree ? tree.folders.filter((f) => !f.isToolbar) : []

  const selectedFolderId: number | null =
    selected.kind === 'other' ? null : selected.kind === 'toolbar' ? selected.id : selected.id

  // 현재 선택된 폴더의 하위 폴더·링크 (기타 북마크 루트는 북마크 바 폴더를 제외한다)
  const content: { folders: BookmarkFolderDto[]; links: BookmarkLinkDto[] } = useMemo(() => {
    if (!tree) return { folders: [], links: [] }
    if (selected.kind === 'other') return { folders: otherRootFolders, links: tree.links }
    const folder = findFolder(tree.folders, selected.id)
    return folder ? { folders: folder.folders, links: folder.links } : { folders: [], links: [] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, selected])

  const searchResults = tree ? searchLinks(tree, query) : []
  const isSearching = query.trim().length > 0

  const flatFolders: FlatFolder[] = useMemo(() => {
    if (!tree) return []
    return [
      { id: -1, label: t('bookmarksPage.root'), depth: 0 },
      ...flattenFolders(tree.folders, 1, t('bookmarksPage.toolbarFolder'))
    ]
  }, [tree, t])

  const toggle = (id: number): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openLink = async (url: string): Promise<void> => {
    await window.samba.tabs.create({ url })
  }

  const openAddFolder = (): void => {
    setFormValue({ name: '', url: '' })
    setDialog({ kind: 'addFolder', parentId: selectedFolderId })
    setTopMenuOpen(false)
  }
  const openAddLink = (): void => {
    setFormValue({ name: '', url: '' })
    setDialog({ kind: 'addLink', folderId: selectedFolderId })
    setTopMenuOpen(false)
  }
  const openRename = (id: number, kind2: 'folder' | 'link', name: string): void => {
    setFormValue({ name, url: '' })
    setDialog({ kind: 'rename', id, kind2, name })
  }
  const openMove = (id: number, kind2: 'folder' | 'link'): void => {
    setDialog({ kind: 'move', id, kind2 })
  }

  // 이동 다이얼로그의 이동 대상 목록 — 폴더를 이동할 때는 자기 자신·자손 폴더를 골라도
  // 거부되므로(repo 의 moveFolder 가드) 애초에 목록에서 빼서 헛수고를 막는다
  const moveTargetFolders: FlatFolder[] = useMemo(() => {
    if (!dialog || dialog.kind !== 'move' || dialog.kind2 !== 'folder' || !tree) {
      return flatFolders
    }
    const movingFolder = findFolder(tree.folders, dialog.id)
    const excluded = new Set(movingFolder ? collectFolderIds(movingFolder) : [dialog.id])
    return flatFolders.filter((f) => !excluded.has(f.id))
  }, [dialog, tree, flatFolders])

  const closeDialog = (): void => setDialog(null)

  const submitDialog = async (): Promise<void> => {
    if (!dialog) return
    if (dialog.kind === 'addFolder') {
      if (!formValue.name.trim()) return
      await createFolder(dialog.parentId, formValue.name.trim())
    } else if (dialog.kind === 'addLink') {
      if (!formValue.name.trim() || !formValue.url.trim()) return
      await createLink(dialog.folderId, formValue.name.trim(), formValue.url.trim())
    } else if (dialog.kind === 'rename') {
      if (!formValue.name.trim()) return
      await rename(dialog.id, dialog.kind2, formValue.name.trim())
    }
    closeDialog()
  }

  const submitMove = async (toFolderId: number | null): Promise<void> => {
    if (!dialog || dialog.kind !== 'move') return
    await move(dialog.id, dialog.kind2, toFolderId)
    closeDialog()
  }

  const onDeleteFolder = async (folder: BookmarkFolderDto): Promise<void> => {
    const label = folder.isToolbar ? t('bookmarksPage.toolbarFolder') : folder.name
    if (!window.confirm(t('bookmarksPage.deleteFolderConfirm', { name: label }))) return
    await removeFolder(folder.id)
  }

  const onSort = async (): Promise<void> => {
    await sort(selectedFolderId)
    setTopMenuOpen(false)
  }

  const onExport = async (): Promise<void> => {
    setTopMenuOpen(false)
    const path = await exportBookmarks()
    setToast(path ? t('bookmarksPage.exportSuccess') : t('bookmarksPage.exportFailed'))
  }

  const onImport = async (): Promise<void> => {
    setTopMenuOpen(false)
    const result = await importBookmarksVault()
    if (result) {
      await load()
      setToast(t('bookmarksPage.importSuccess'))
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* 왼쪽 폴더 트리 */}
      <aside className="flex w-56 shrink-0 flex-col overflow-auto border-r border-[var(--line)] p-2">
        <button
          type="button"
          onClick={() =>
            setSelected(
              toolbarFolder ? { kind: 'toolbar', id: toolbarFolder.id } : { kind: 'other' }
            )
          }
          style={{ paddingLeft: 10 }}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px]',
            selected.kind === 'toolbar'
              ? 'bg-black/[.06] font-medium text-[var(--text)]'
              : 'text-[var(--text2)] hover:bg-black/5'
          )}
        >
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate">{t('bookmarksPage.toolbarFolder')}</span>
        </button>
        {toolbarFolder?.folders.map((f) => (
          <TreeFolderRow
            key={f.id}
            folder={f}
            depth={1}
            selected={selected}
            selectedId={
              selected.kind === 'toolbar' || selected.kind === 'folder' ? selected.id : undefined
            }
            expanded={expanded}
            onToggle={toggle}
            onSelect={setSelected}
          />
        ))}
        <button
          type="button"
          onClick={() => setSelected({ kind: 'other' })}
          style={{ paddingLeft: 10 }}
          className={cn(
            'mt-1.5 flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px]',
            selected.kind === 'other'
              ? 'bg-black/[.06] font-medium text-[var(--text)]'
              : 'text-[var(--text2)] hover:bg-black/5'
          )}
        >
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate">{t('bookmarksPage.otherFolder')}</span>
        </button>
        {otherRootFolders.map((f) => (
          <TreeFolderRow
            key={f.id}
            folder={f}
            depth={1}
            selected={selected}
            selectedId={
              selected.kind === 'toolbar' || selected.kind === 'folder' ? selected.id : undefined
            }
            expanded={expanded}
            onToggle={toggle}
            onSelect={setSelected}
          />
        ))}
      </aside>

      {/* 가운데 목록 */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
          <h1 className="text-[15px] font-semibold text-[var(--text)]">
            {t('bookmarksPage.title')}
          </h1>
          <div className="relative ml-4 max-w-[320px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text3)]" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('bookmarksPage.searchPlaceholder')}
              className="h-8 rounded-[9px] pl-8 text-[12.5px]"
            />
          </div>
          <div className="ml-auto">
            <Popover open={topMenuOpen} onOpenChange={setTopMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text2)] hover:bg-black/5"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52">
                <MenuItemIcon
                  icon={<ArrowDownAZ className="h-3.5 w-3.5" />}
                  label={t('bookmarksPage.topMenu.sortByName')}
                  onClick={() => void onSort()}
                />
                <MenuItemIcon
                  icon={<Plus className="h-3.5 w-3.5" />}
                  label={t('bookmarksPage.topMenu.addBookmark')}
                  onClick={openAddLink}
                />
                <MenuItemIcon
                  icon={<FolderPlus className="h-3.5 w-3.5" />}
                  label={t('bookmarksPage.topMenu.addFolder')}
                  onClick={openAddFolder}
                />
                <MenuItemIcon
                  icon={<Upload className="h-3.5 w-3.5" />}
                  label={t('bookmarksPage.topMenu.import')}
                  onClick={() => void onImport()}
                />
                <MenuItemIcon
                  icon={<Download className="h-3.5 w-3.5" />}
                  label={t('bookmarksPage.topMenu.export')}
                  onClick={() => void onExport()}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {toast && (
            <div className="mb-2 rounded-[9px] bg-black/[.04] px-3 py-1.5 text-[12px] text-[var(--text2)]">
              {toast}
            </div>
          )}

          {isSearching ? (
            searchResults.length === 0 ? (
              <p className="px-2.5 py-2 text-[12.5px] text-[var(--text3)]">
                {t('bookmarksPage.noSearchResults')}
              </p>
            ) : (
              searchResults.map((l) => (
                <ContentRow
                  key={l.id}
                  icon={<LetterFavicon title={l.title || l.url} />}
                  name={l.title || l.url}
                  url={l.url}
                  onOpen={() => void openLink(l.url)}
                  onRename={() => openRename(l.id, 'link', l.title)}
                  onMove={() => openMove(l.id, 'link')}
                  onDelete={() => void removeLink(l.id)}
                />
              ))
            )
          ) : content.folders.length === 0 && content.links.length === 0 ? (
            <p className="px-2.5 py-2 text-[12.5px] text-[var(--text3)]">
              {t('bookmarksPage.empty')}
            </p>
          ) : (
            <>
              {content.folders.map((f) => (
                <ContentRow
                  key={f.id}
                  icon={<FolderIcon />}
                  name={f.isToolbar ? t('bookmarksPage.toolbarFolder') : f.name}
                  onOpen={() =>
                    setSelected(
                      f.isToolbar ? { kind: 'toolbar', id: f.id } : { kind: 'folder', id: f.id }
                    )
                  }
                  onRename={() => openRename(f.id, 'folder', f.name)}
                  onMove={() => openMove(f.id, 'folder')}
                  onDelete={() => void onDeleteFolder(f)}
                />
              ))}
              {content.links.map((l) => (
                <ContentRow
                  key={l.id}
                  icon={<LetterFavicon title={l.title || l.url} />}
                  name={l.title || l.url}
                  url={l.url}
                  onOpen={() => void openLink(l.url)}
                  onRename={() => openRename(l.id, 'link', l.title)}
                  onMove={() => openMove(l.id, 'link')}
                  onDelete={() => void removeLink(l.id)}
                />
              ))}
            </>
          )}
        </div>
      </section>

      {/* 추가/이름변경 다이얼로그 */}
      <Dialog
        open={
          dialog?.kind === 'addFolder' || dialog?.kind === 'addLink' || dialog?.kind === 'rename'
        }
        onOpenChange={(o) => !o && closeDialog()}
      >
        <DialogContent className="rounded-2xl sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'addFolder' && t('bookmarksPage.dialog.addFolderTitle')}
              {dialog?.kind === 'addLink' && t('bookmarksPage.dialog.addBookmarkTitle')}
              {dialog?.kind === 'rename' && t('bookmarksPage.dialog.renameTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1 text-[12px] text-[var(--text2)]">
              {dialog?.kind === 'addLink'
                ? t('bookmarksPage.dialog.titleLabel')
                : t('bookmarksPage.dialog.nameLabel')}
              <Input
                autoFocus
                value={formValue.name}
                onChange={(e) => setFormValue((v) => ({ ...v, name: e.target.value }))}
                className="h-9 rounded-[9px]"
              />
            </label>
            {dialog?.kind === 'addLink' && (
              <label className="flex flex-col gap-1 text-[12px] text-[var(--text2)]">
                {t('bookmarksPage.dialog.urlLabel')}
                <Input
                  value={formValue.url}
                  onChange={(e) => setFormValue((v) => ({ ...v, url: e.target.value }))}
                  placeholder="https://"
                  className="h-9 rounded-[9px]"
                />
              </label>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t('bookmarksPage.dialog.cancel')}
            </Button>
            <Button type="button" onClick={() => void submitDialog()}>
              {dialog?.kind === 'rename'
                ? t('bookmarksPage.dialog.save')
                : t('bookmarksPage.dialog.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 이동 다이얼로그 */}
      <Dialog open={dialog?.kind === 'move'} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="rounded-2xl sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('bookmarksPage.dialog.moveTitle')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[320px] overflow-auto">
            {moveTargetFolders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => void submitMove(f.id === -1 ? null : f.id)}
                style={{ paddingLeft: 10 + f.depth * 14 }}
                className="flex w-full items-center gap-1.5 rounded-[8px] py-1.5 pr-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5"
              >
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MenuItemIcon({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5"
    >
      {icon}
      {label}
    </button>
  )
}
