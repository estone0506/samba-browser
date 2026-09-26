import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Star } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { BookmarkFolderDto, BookmarkTreeDto } from '../../../../shared/import'

// 주소창 안 별 버튼 — 크롬처럼 누르면 지금 페이지를 북마크바에 넣고, 이미 있으면 뺀다

/** 트리에서 같은 주소의 링크 id 를 찾는다(최상위 → 폴더 깊이 순). 없으면 null */
export function findBookmarkId(tree: BookmarkTreeDto, url: string): number | null {
  const hit = tree.links.find((l) => l.url === url)
  if (hit) return hit.id
  const walk = (folders: BookmarkFolderDto[]): number | null => {
    for (const f of folders) {
      const link = f.links.find((l) => l.url === url)
      if (link) return link.id
      const deep = walk(f.folders)
      if (deep !== null) return deep
    }
    return null
  }
  return walk(tree.folders)
}

/** 새 북마크를 넣을 폴더 — 북마크바 폴더가 있으면 그곳, 없으면 최상위(null) */
export function toolbarFolderId(tree: BookmarkTreeDto): number | null {
  const walk = (folders: BookmarkFolderDto[]): number | null => {
    for (const f of folders) {
      if (f.isToolbar) return f.id
      const deep = walk(f.folders)
      if (deep !== null) return deep
    }
    return null
  }
  return walk(tree.folders)
}

/** 북마크할 수 있는 주소인가 — 웹 주소만(새 탭·앱 내부 페이지는 뺀다) */
export function isBookmarkableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url)
}

export function BookmarkStar({ url, title }: { url?: string; title?: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [bookmarkId, setBookmarkId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!isBookmarkableUrl(url)) {
      setBookmarkId(null)
      return
    }
    const r = await window.samba.bookmarks.tree()
    setBookmarkId(r.ok ? findBookmarkId(r.data, url) : null)
  }, [url])

  // 주소가 바뀔 때마다 이 페이지가 이미 북마크돼 있는지 다시 본다
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!isBookmarkableUrl(url)) return null
  const saved = bookmarkId !== null

  const toggle = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (saved) {
        await window.samba.bookmarks.remove(bookmarkId)
      } else {
        const tree = await window.samba.bookmarks.tree()
        const folderId = tree.ok ? toolbarFolderId(tree.data) : null
        await window.samba.bookmarks.createLink(folderId, title?.trim() || url, url)
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      title={saved ? t('address.bookmarkRemove') : t('address.bookmarkAdd')}
      aria-label={saved ? t('address.bookmarkRemove') : t('address.bookmarkAdd')}
      aria-pressed={saved}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text3)] hover:bg-black/5"
    >
      <Star className={cn('h-3.5 w-3.5', saved && 'fill-amber-400 text-amber-400')} />
    </button>
  )
}
