// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { ImportService, type ImportDialogs } from '../src/main/import/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const MASTER = 'sup3rs3cret!'

function makeSettings(): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS }
  return { get: () => value }
}

// 파일 선택 다이얼로그 스텁 — 항상 cancelled 를 반환해 filePath 생략 경로도 검증할 수 있게 한다
function makeDialogs(chosenPath?: string): ImportDialogs {
  return {
    showOpenDialog: async () => chosenPath
  }
}

const CSV_FIXTURE = [
  'name,url,username,password,note',
  'Example,https://www.example.com/login,user1,pass1,',
  'Example2,https://example2.com,user2,pass2,',
  ',,onlyuser,,', // username 은 있지만 password 없음 → 파서 단계에서 skipped
  'NoHost,not a url at all,user3,pass3,' // host 정규화 실패 → 서비스 단계에서 skipped
].join('\n')

const BOOKMARK_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">북마크바</H3>
    <DL><p>
        <DT><A HREF="https://a.example.com">A 사이트</A>
        <DT><H3>하위 폴더</H3>
        <DL><p>
            <DT><A HREF="https://b.example.com">B 사이트</A>
        </DL><p>
    </DL><p>
</DL><p>
`

describe('ImportService', () => {
  let db: Db
  let vault: VaultService

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, makeSettings())
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  describe('importPasswords', () => {
    it('금고가 잠겨 있으면 locked 에러를 던진다', async () => {
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => CSV_FIXTURE
      })
      await expect(service.importPasswords('logins.csv')).rejects.toThrow('locked')
    })

    it('첫 가져오기: added/skipped 카운트가 맞는다', async () => {
      await vault.setup(MASTER)
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => CSV_FIXTURE
      })
      const result = await service.importPasswords('logins.csv')

      expect(result.total).toBe(3) // 파서 단계에서 1행 skip 됨(username 없음/password 없음)
      expect(result.added).toBe(2)
      expect(result.updated).toBe(0)
      expect(result.skipped).toBe(2) // 파서 1 + 호스트 정규화 실패 1
      expect(result.sites).toBe(2)

      const accounts = vault.listAccounts('example.com')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].username).toBe('user1')
      expect(accounts[0].itemTypes).toContain('login')
    })

    it('같은 CSV 를 다시 가져오면 전부 updated, added 는 0이다', async () => {
      await vault.setup(MASTER)
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => CSV_FIXTURE
      })
      await service.importPasswords('logins.csv')
      const second = await service.importPasswords('logins.csv')

      expect(second.added).toBe(0)
      expect(second.updated).toBe(2)
    })

    it('www. 접두사가 다른 호스트는 같은 계정으로 병합된다', async () => {
      await vault.setup(MASTER)
      const csv = [
        'name,url,username,password',
        'Example,https://www.merge.example.com,userA,passA'
      ].join('\n')
      const service = new ImportService(db, vault, makeDialogs(), { readFile: async () => csv })
      await service.importPasswords('a.csv')

      const csv2 = [
        'name,url,username,password',
        'Example,https://merge.example.com,userA,passA2'
      ].join('\n')
      const service2 = new ImportService(db, vault, makeDialogs(), { readFile: async () => csv2 })
      const result = await service2.importPasswords('b.csv')

      expect(result.added).toBe(0)
      expect(result.updated).toBe(1)
      expect(vault.listAccounts('merge.example.com')).toHaveLength(1)
    })

    it('filePath 를 생략하고 다이얼로그가 취소되면 cancelled 에러를 던진다', async () => {
      await vault.setup(MASTER)
      const service = new ImportService(db, vault, makeDialogs(undefined), {
        readFile: async () => CSV_FIXTURE
      })
      await expect(service.importPasswords()).rejects.toThrow('cancelled')
    })

    it('가져오기 후 감사 로그가 한 줄 남는다(itemId 는 null)', async () => {
      await vault.setup(MASTER)
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => CSV_FIXTURE
      })
      await service.importPasswords('logins.csv')

      const audit = vault.listAudit()
      const importRow = audit.find((r) => r.action === 'import')
      expect(importRow).toBeDefined()
      expect(importRow?.itemId).toBeNull()
    })

    it('결과 JSON 어디에도 비밀번호 문자열이 없다', async () => {
      await vault.setup(MASTER)
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => CSV_FIXTURE
      })
      const result = await service.importPasswords('logins.csv')
      const json = JSON.stringify(result)
      expect(json).not.toMatch(/pass1|pass2|pass3/)
    })
  })

  describe('importBookmarks', () => {
    it('폴더 중첩과 툴바 플래그를 저장하고 트리로 되돌려 준다', async () => {
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => BOOKMARK_HTML
      })
      const result = await service.importBookmarks('bookmarks.html')

      expect(result.folders).toBe(2)
      expect(result.bookmarks).toBe(2)
      expect(result.skipped).toBe(0)

      const tree = service.tree()
      expect(tree.folders).toHaveLength(1)
      expect(tree.folders[0].name).toBe('북마크바')
      expect(tree.folders[0].isToolbar).toBe(true)
      expect(tree.folders[0].links.map((l) => l.title)).toEqual(['A 사이트'])
      expect(tree.folders[0].folders).toHaveLength(1)
      expect(tree.folders[0].folders[0].name).toBe('하위 폴더')
      expect(tree.folders[0].folders[0].links.map((l) => l.title)).toEqual(['B 사이트'])
    })

    it('같은 URL 을 다시 가져오면 전부 skipped 처리된다(dedupeUrls)', async () => {
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => BOOKMARK_HTML
      })
      await service.importBookmarks('bookmarks.html')
      const second = await service.importBookmarks('bookmarks.html')

      expect(second.bookmarks).toBe(0)
      expect(second.skipped).toBe(2)
    })

    it('북마크 가져오기는 감사 로그를 남기지 않는다(감사 로그는 비밀 항목 전용)', async () => {
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => BOOKMARK_HTML
      })
      await service.importBookmarks('bookmarks.html')

      const audit = vault.listAudit()
      expect(audit.some((r) => r.action === 'import')).toBe(false)
    })

    it('트리 DTO JSON 에 비밀번호 문자열이 없다(가져온 계정과 무관한 데이터임을 확인)', async () => {
      const service = new ImportService(db, vault, makeDialogs(), {
        readFile: async () => BOOKMARK_HTML
      })
      await service.importBookmarks('bookmarks.html')
      const json = JSON.stringify(service.tree())
      expect(json).not.toMatch(/pass1|pass2|pass3/)
    })
  })
})
