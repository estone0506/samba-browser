// 작업공간 범위 필터 — 금고 계정/항목과 북마크 링크가 활성 작업공간으로 걸러지는지 본다.
// 2b 이전에 만들어진 행(workspace_id = NULL)은 기본 작업공간에서만 보여야 한다.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultRepo } from '../src/main/vault/repo'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import type { WorkspaceScope } from '../src/shared/sync'

const DEFAULT_SCOPE: WorkspaceScope = { id: 1, isDefault: true }
const WORK_SCOPE: WorkspaceScope = { id: 2, isDefault: false }

describe('작업공간 범위 필터 — 금고', () => {
  let db: Db
  let repo: VaultRepo

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    repo = new VaultRepo(db)
  })
  afterEach(() => db.close())

  it('범위를 정하지 않으면 모든 계정이 보인다(기존 동작)', () => {
    repo.upsertAccount({ host: 'a.example', username: 'u1' })
    expect(repo.listAccounts()).toHaveLength(1)
  })

  it('다른 작업공간에서 만든 계정은 서로 보이지 않는다', () => {
    repo.setWorkspaceScope(DEFAULT_SCOPE)
    repo.upsertAccount({ host: 'a.example', username: 'u1' })
    repo.setWorkspaceScope(WORK_SCOPE)
    repo.upsertAccount({ host: 'b.example', username: 'u2' })

    expect(repo.listAccounts().map((a) => a.username)).toEqual(['u2'])
    repo.setWorkspaceScope(DEFAULT_SCOPE)
    expect(repo.listAccounts().map((a) => a.username)).toEqual(['u1'])
  })

  it('작업공간이 없던 시절의 계정(NULL)은 기본 작업공간에서만 보인다', () => {
    // 범위 없이 만든 행 = workspace_id NULL
    repo.upsertAccount({ host: 'old.example', username: 'old' })

    repo.setWorkspaceScope(DEFAULT_SCOPE)
    expect(repo.listAccounts().map((a) => a.username)).toEqual(['old'])
    repo.setWorkspaceScope(WORK_SCOPE)
    expect(repo.listAccounts()).toHaveLength(0)
  })
})

describe('작업공간 범위 필터 — 북마크', () => {
  let db: Db
  let repo: BookmarkRepo

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    repo = new BookmarkRepo(db)
  })
  afterEach(() => db.close())

  it('작업공간마다 자기 링크만 보인다', () => {
    repo.setWorkspaceScope(DEFAULT_SCOPE)
    repo.createLink(null, '개인', 'https://personal.example/')
    repo.setWorkspaceScope(WORK_SCOPE)
    repo.createLink(null, '업무', 'https://work.example/')

    expect(repo.tree().links.map((l) => l.title)).toEqual(['업무'])
    repo.setWorkspaceScope(DEFAULT_SCOPE)
    expect(repo.tree().links.map((l) => l.title)).toEqual(['개인'])
  })

  it('작업공간이 없던 시절의 링크(NULL)는 기본 작업공간에서만 보인다', () => {
    repo.createLink(null, '옛 링크', 'https://old.example/')

    repo.setWorkspaceScope(DEFAULT_SCOPE)
    expect(repo.tree().links).toHaveLength(1)
    repo.setWorkspaceScope(WORK_SCOPE)
    expect(repo.tree().links).toHaveLength(0)
  })
})
