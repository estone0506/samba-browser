// 북마크 저장소 — 폴더/링크 트리를 DB 에 저장하고, 트리 DTO 로 조회한다.
// 같은 URL 의 링크는 전체 DB 기준으로 이미 있으면 건너뛴다(폴더 위치와 무관하게 중복 제거).

import { eq, or, isNull, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { OutboxRecorder } from '../../shared/sync'
import { bookmarkFolders, bookmarks } from '../db/schema'
import type { BookmarkFolderNode, BookmarkTree } from '../import/bookmarks-html'
import type { BookmarkFolderDto, BookmarkLinkDto, BookmarkTreeDto } from '../../shared/import'
import { isAllowedExternalUrl } from '../../shared/url'
import type { WorkspaceScope } from '../../shared/sync'

export interface InsertTreeResult {
  folders: number
  bookmarks: number
  skipped: number
}

interface FolderRow {
  id: number
  parentId: number | null
  name: string
  position: number
  isToolbar: boolean
  addDate: number | null
}

interface BookmarkRow {
  id: number
  folderId: number | null
  title: string
  url: string
  position: number
  addedAt: number | null
}

export class BookmarkRepo {
  // 동기화 변경 로그 훅. 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태)
  private outbox: OutboxRecorder | null = null

  constructor(private readonly db: Db) {}

  // 현재 작업공간. null 이면 범위 제한 없이 전부 본다(작업공간 기능이 붙기 전 동작).
  // 폴더에는 작업공간 컬럼이 없어 링크만 걸러진다 — 폴더 구조는 작업공간끼리 공유된다
  private scope: WorkspaceScope | null = null

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  /** 활성 작업공간을 알려 준다. 이후의 조회는 이 범위로 걸러지고, 새 링크는 이 작업공간에 붙는다 */
  setWorkspaceScope(scope: WorkspaceScope | null): void {
    this.scope = scope
  }

  /** 새 링크에 붙일 작업공간 id */
  private get scopeId(): number | null {
    return this.scope ? this.scope.id : null
  }

  /**
   * 작업공간 범위 조건. 기본 작업공간에서는 작업공간이 없던 시절의 링크(NULL)도 함께 보인다
   */
  private scopeWhere(): SQL | undefined {
    if (!this.scope) return undefined
    if (this.scope.isDefault)
      return or(isNull(bookmarks.workspaceId), eq(bookmarks.workspaceId, this.scope.id))
    return eq(bookmarks.workspaceId, this.scope.id)
  }

  /** 변경 로그 훅을 붙인다(로그인 상태에서만) */
  setOutboxRecorder(recorder: OutboxRecorder | null): void {
    this.outbox = recorder
  }

  /** 삭제는 행이 사라지기 전에 기록해야 한다 — 호출 순서에 주의 */
  private record(id: number, op: 'upsert' | 'delete'): void {
    this.outbox?.('bookmarks', String(id), op)
  }

  // 이미 저장된 URL 목록(전체 DB 기준) — 트리 삽입 전에 한 번만 읽어 중복 판단에 쓴다
  private existingUrls(): Set<string> {
    const where = this.scopeWhere()
    const base = this.d.select({ url: bookmarks.url }).from(bookmarks)
    const rows = (where ? base.where(where) : base).all()
    return new Set(rows.map((r) => r.url))
  }

  private insertFolder(
    node: BookmarkFolderNode,
    parentId: number | null,
    position: number
  ): number {
    const inserted = this.d
      .insert(bookmarkFolders)
      .values({
        parentId,
        name: node.name,
        position,
        isToolbar: node.isToolbar ? 1 : 0,
        addDate: node.addDate ?? null
      })
      .returning({ id: bookmarkFolders.id })
      .all()
    return inserted[0].id
  }

  private insertLink(
    folderId: number | null,
    title: string,
    url: string,
    position: number,
    addedAt?: number
  ): void {
    this.d
      .insert(bookmarks)
      .values({
        folderId,
        title,
        url,
        position,
        addedAt: addedAt ?? null,
        workspaceId: this.scopeId
      })
      .run()
  }

  private insertNode(
    node: BookmarkTree,
    parentId: number | null,
    seenUrls: Set<string>,
    result: InsertTreeResult
  ): void {
    let linkPosition = 0
    for (const link of node.links) {
      if (seenUrls.has(link.url)) {
        result.skipped += 1
        continue
      }
      seenUrls.add(link.url)
      this.insertLink(parentId, link.title, link.url, linkPosition, link.addDate)
      linkPosition += 1
      result.bookmarks += 1
    }

    let folderPosition = 0
    for (const folder of node.folders) {
      const folderId = this.insertFolder(folder, parentId, folderPosition)
      folderPosition += 1
      result.folders += 1
      this.insertNode(folder, folderId, seenUrls, result)
    }
  }

  // 트리 전체를 한 트랜잭션으로 저장한다
  insertTree(tree: BookmarkTree, parentId: number | null = null): InsertTreeResult {
    const result: InsertTreeResult = { folders: 0, bookmarks: 0, skipped: 0 }
    this.d.transaction(() => {
      const seenUrls = this.existingUrls()
      this.insertNode(tree, parentId, seenUrls, result)
    })
    this.db.scheduleSave()
    return result
  }

  private folderRows(): FolderRow[] {
    return this.d
      .select()
      .from(bookmarkFolders)
      .all()
      .map((r) => ({
        id: r.id,
        parentId: r.parentId,
        name: r.name,
        position: r.position,
        isToolbar: r.isToolbar !== 0,
        addDate: r.addDate
      }))
  }

  private bookmarkRows(): BookmarkRow[] {
    const where = this.scopeWhere()
    const base = this.d.select().from(bookmarks)
    return (where ? base.where(where) : base).all().map((r) => ({
      id: r.id,
      folderId: r.folderId,
      title: r.title,
      url: r.url,
      position: r.position,
      addedAt: r.addedAt
    }))
  }

  private buildTree(
    parentId: number | null,
    folders: FolderRow[],
    links: BookmarkRow[]
  ): BookmarkTreeDto {
    const childFolders = folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.position - b.position)
    const childLinks = links
      .filter((b) => b.folderId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((b): BookmarkLinkDto => ({
        id: b.id,
        title: b.title,
        url: b.url,
        ...(b.addedAt !== null ? { addDate: b.addedAt } : {})
      }))

    const folderDtos: BookmarkFolderDto[] = childFolders.map((f) => {
      const sub = this.buildTree(f.id, folders, links)
      return {
        id: f.id,
        name: f.name,
        isToolbar: f.isToolbar,
        ...(f.addDate !== null ? { addDate: f.addDate } : {}),
        folders: sub.folders,
        links: sub.links
      }
    })

    return { folders: folderDtos, links: childLinks }
  }

  // 루트(폴더 없음)부터 시작하는 트리 DTO
  tree(): BookmarkTreeDto {
    return this.buildTree(null, this.folderRows(), this.bookmarkRows())
  }

  // 북마크 링크 하나를 제거한다
  remove(id: number): void {
    // 삭제 표식을 만들려면 행이 남아 있어야 한다 — 반드시 지우기 전에 기록한다
    this.record(id, 'delete')
    this.d.delete(bookmarks).where(eq(bookmarks.id, id)).run()
    this.db.scheduleSave()
  }

  // --- 북마크 관리자 페이지용 CRUD ------------------------------------------

  private nextFolderPosition(parentId: number | null): number {
    const siblings = this.folderRows().filter((f) => f.parentId === parentId)
    return siblings.length
  }

  private nextLinkPosition(folderId: number | null): number {
    const siblings = this.bookmarkRows().filter((b) => b.folderId === folderId)
    return siblings.length
  }

  createFolder(parentId: number | null, name: string): number {
    const id = this.insertFolder(
      { name, isToolbar: false, folders: [], links: [] },
      parentId,
      this.nextFolderPosition(parentId)
    )
    this.db.scheduleSave()
    return id
  }

  createLink(folderId: number | null, title: string, url: string): number {
    // http(s)/about:blank 이외 스킴(javascript:, data: 등)은 거부한다
    if (!isAllowedExternalUrl(url))
      throw new Error('cannot create bookmark link: URL scheme not allowed')
    const inserted = this.d
      .insert(bookmarks)
      .values({
        folderId,
        title,
        url,
        position: this.nextLinkPosition(folderId),
        workspaceId: this.scopeId,
        updatedAt: Date.now()
      })
      .returning({ id: bookmarks.id })
      .all()
    this.db.scheduleSave()
    this.record(inserted[0].id, 'upsert')
    return inserted[0].id
  }

  renameFolder(id: number, name: string): void {
    this.d.update(bookmarkFolders).set({ name }).where(eq(bookmarkFolders.id, id)).run()
    this.db.scheduleSave()
  }

  renameLink(id: number, title: string): void {
    this.d.update(bookmarks).set({ title, updatedAt: Date.now() }).where(eq(bookmarks.id, id)).run()
    this.db.scheduleSave()
    this.record(id, 'upsert')
  }

  // toFolderId 가 id 자신이거나 id 의 자손이면 이동을 거부한다(트리가 끊어지는 것을 막는다)
  private isSelfOrDescendant(id: number, toFolderId: number | null): boolean {
    if (toFolderId === null) return false
    if (toFolderId === id) return true
    const folders = this.folderRows()
    const byId = new Map(folders.map((f) => [f.id, f]))
    let cursor: number | null = toFolderId
    const visited = new Set<number>()
    while (cursor !== null) {
      if (cursor === id) return true
      if (visited.has(cursor)) break // 순환 방어
      visited.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
    return false
  }

  moveFolder(id: number, toFolderId: number | null): void {
    if (this.isSelfOrDescendant(id, toFolderId)) {
      throw new Error('cannot move folder into itself or its descendant')
    }
    this.d
      .update(bookmarkFolders)
      .set({ parentId: toFolderId, position: this.nextFolderPosition(toFolderId) })
      .where(eq(bookmarkFolders.id, id))
      .run()
    this.db.scheduleSave()
  }

  moveLink(id: number, toFolderId: number | null): void {
    this.d
      .update(bookmarks)
      .set({
        folderId: toFolderId,
        position: this.nextLinkPosition(toFolderId),
        updatedAt: Date.now()
      })
      .where(eq(bookmarks.id, id))
      .run()
    this.db.scheduleSave()
    this.record(id, 'upsert')
  }

  // 폴더 제거(cascade) — DB 에 부모→자식 FK 가 없어(자기참조) 하위 폴더/링크를 직접 수집해 지운다
  removeFolder(id: number): void {
    const folders = this.folderRows()
    const idsToRemove: number[] = []
    const visited = new Set<number>() // 순환 방어 — 데이터가 꼬여 있어도 무한 재귀에 빠지지 않는다
    const collect = (folderId: number): void => {
      if (visited.has(folderId)) return
      visited.add(folderId)
      idsToRemove.push(folderId)
      for (const f of folders.filter((f) => f.parentId === folderId)) collect(f.id)
    }
    collect(id)

    this.d.transaction(() => {
      for (const folderId of idsToRemove) {
        this.d.delete(bookmarks).where(eq(bookmarks.folderId, folderId)).run()
      }
      for (const folderId of idsToRemove) {
        this.d.delete(bookmarkFolders).where(eq(bookmarkFolders.id, folderId)).run()
      }
    })
    this.db.scheduleSave()
  }

  // 폴더 하나(직계 자식만) 를 이름순으로 재정렬한다 — 하위 폴더가 링크보다 앞에 오도록,
  // 각 그룹 안에서는 이름 오름차순(로케일 비교)
  sortFolder(folderId: number | null): void {
    const folders = this.folderRows()
      .filter((f) => f.parentId === folderId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    const links = this.bookmarkRows()
      .filter((b) => b.folderId === folderId)
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'))

    this.d.transaction(() => {
      folders.forEach((f, i) => {
        this.d
          .update(bookmarkFolders)
          .set({ position: i })
          .where(eq(bookmarkFolders.id, f.id))
          .run()
      })
      links.forEach((b, i) => {
        this.d.update(bookmarks).set({ position: i }).where(eq(bookmarks.id, b.id)).run()
      })
    })
    this.db.scheduleSave()
  }
}
