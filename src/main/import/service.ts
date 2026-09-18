// 가져오기 서비스 — 비밀번호 CSV/북마크 HTML 파일을 읽어 DB 에 반영한다.
// 비밀값(비밀번호) · 행 원문은 처리 즉시 참조를 해제하고, 어떤 로그에도 남기지 않는다.

import { readFile as fsReadFile } from 'node:fs/promises'
import type { Db } from '../db/client'
import type { VaultService } from '../vault/service'
import { BookmarkRepo } from '../bookmarks/repo'
import { parsePasswordCsv } from './passwords-csv'
import { parseNetscapeBookmarks } from './bookmarks-html'
import { normalizeHost } from '../../shared/host'
import type { ImportPasswordsResult, ImportBookmarksResult } from '../../shared/import'

// dialog.showOpenDialog 를 감싼 최소 인터페이스 — 테스트에서 파일 선택을 흉내낼 수 있게 주입한다.
// 취소되면 undefined 를 반환한다
export interface ImportDialogs {
  showOpenDialog(filters: { name: string; extensions: string[] }[]): Promise<string | undefined>
}

export interface ImportServiceOptions {
  // 기본은 fs/promises readFile(utf8). 테스트에서 합성 CSV/HTML 문자열을 주입할 때 사용
  readFile?: (filePath: string) => Promise<string>
}

const CSV_FILTERS = [{ name: 'CSV', extensions: ['csv'] }]
const HTML_FILTERS = [{ name: 'HTML', extensions: ['html', 'htm'] }]
const BOM = '﻿'

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

export class ImportService {
  private readonly bookmarkRepo: BookmarkRepo
  private readonly readFileImpl: (filePath: string) => Promise<string>

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly dialogs: ImportDialogs,
    options: ImportServiceOptions = {}
  ) {
    this.bookmarkRepo = new BookmarkRepo(db)
    this.readFileImpl = options.readFile ?? ((p) => fsReadFile(p, 'utf8'))
  }

  /**
   * 비밀번호 CSV 를 가져온다. 금고가 잠겨 있으면 'locked' 에러를 던진다.
   * (host, username) 조합이 이미 있으면 비밀번호만 갱신하고, 없으면 계정+항목을 새로 만든다.
   */
  async importPasswords(filePath?: string): Promise<ImportPasswordsResult> {
    if (this.vault.state() !== 'unlocked') throw new Error('locked')

    const path = filePath ?? (await this.dialogs.showOpenDialog(CSV_FILTERS))
    if (!path) throw new Error('cancelled')

    // CSV 원문은 파싱 직후 곧바로 참조를 해제한다(비밀번호가 담긴 문자열을 오래 들고 있지 않는다)
    let text: string | undefined = stripBom(await this.readFileImpl(path))
    let parsed: { rows: ReturnType<typeof parsePasswordCsv>['rows']; skipped: number } | undefined =
      parsePasswordCsv(text)
    text = undefined

    const result: ImportPasswordsResult = {
      total: parsed.rows.length,
      added: 0,
      updated: 0,
      skipped: parsed.skipped,
      sites: 0
    }
    const seenHosts = new Set<string>()

    for (const row of parsed.rows) {
      const host = normalizeHost(row.url) || normalizeHost(row.host)
      if (!host) {
        result.skipped += 1
        continue
      }
      seenHosts.add(host)

      const existing = this.vault.listAccounts(host).find((a) => a.username === row.username)

      const account = this.vault.upsertAccount({
        id: existing?.id,
        host,
        label: existing?.label ?? row.username,
        username: row.username,
        siteName: row.name || host,
        ...(row.url ? { loginUrl: row.url } : {})
      })

      this.vault.putItem({
        accountId: account.id,
        type: 'login_password',
        label: '로그인 비밀번호',
        value: row.password
      })

      if (existing) result.updated += 1
      else result.added += 1
    }

    result.sites = seenHosts.size
    // 비밀번호가 담긴 파싱 결과 참조를 더 이상 들고 있지 않는다
    parsed = undefined

    this.vault.logAudit('import', 'user')
    this.db.scheduleSave()
    return result
  }

  /** 북마크 Netscape HTML 을 가져온다. 이미 있는 URL 은 건너뛴다(전체 DB 기준) */
  async importBookmarks(filePath?: string): Promise<ImportBookmarksResult> {
    const path = filePath ?? (await this.dialogs.showOpenDialog(HTML_FILTERS))
    if (!path) throw new Error('cancelled')

    let html: string | undefined = stripBom(await this.readFileImpl(path))
    let tree: ReturnType<typeof parseNetscapeBookmarks> | undefined = parseNetscapeBookmarks(html, {
      dedupeUrls: true
    })
    html = undefined

    const inserted = this.bookmarkRepo.insertTree(tree)
    tree = undefined

    this.vault.logAudit('import', 'user')
    return { folders: inserted.folders, bookmarks: inserted.bookmarks, skipped: inserted.skipped }
  }

  tree(): ReturnType<BookmarkRepo['tree']> {
    return this.bookmarkRepo.tree()
  }

  removeBookmark(id: number): void {
    this.bookmarkRepo.remove(id)
  }
}
