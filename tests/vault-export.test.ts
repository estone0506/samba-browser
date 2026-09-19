// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import {
  EXPORT_CSV_HEADER,
  buildCsv,
  buildJson,
  exportVault,
  writeOwnerOnlyFile,
  type ExportDeps,
  type ExportRow,
  type OwnerOnlyFs
} from '../src/main/vault/export'
import { parsePasswordCsv } from '../src/main/import/passwords-csv'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const MASTER = 'sup3rs3cret!'

function makeSettings(): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS }
  return { get: () => value }
}

function row(patch: Partial<ExportRow> = {}): ExportRow {
  return {
    type: 'login',
    label: '예시',
    host: 'example.com',
    url: 'https://example.com/login',
    username: 'user1',
    note: '',
    fields: { value: 'pass1' },
    ...patch
  }
}

// 파일 쓰기·저장 다이얼로그를 메모리로 대체한 의존성 묶음
function makeDeps(
  vault: VaultService,
  // null 은 "사용자가 저장 다이얼로그를 취소했다" 는 뜻이다
  chosenPath: string | null = 'C:/tmp/keymaster.csv'
): ExportDeps & { written: Map<string, string>; prompts: unknown[] } {
  const written = new Map<string, string>()
  const prompts: unknown[] = []
  return {
    vault,
    written,
    prompts,
    showSaveDialog: async (prompt) => {
      prompts.push(prompt)
      return chosenPath ?? undefined
    },
    writeFile: async (filePath, content) => {
      written.set(filePath, content)
    },
    now: () => 1_700_000_000_000
  }
}

// 계정 1개 + 로그인 항목 1개를 심는다
function seedLogin(
  vault: VaultService,
  host: string,
  username: string,
  password: string,
  label = username
): void {
  const account = vault.upsertAccount({
    host,
    label,
    username,
    urls: [`https://${host}/login`]
  })
  vault.putItem({
    accountId: account.id,
    type: 'login',
    label: '로그인 비밀번호',
    value: password
  })
}

describe('buildCsv', () => {
  it('첫 줄이 크롬 호환 헤더와 정확히 일치한다', () => {
    const csv = buildCsv([row()])
    expect(csv.split(/\r?\n/)[0]).toBe('name,url,username,password,note')
    expect(EXPORT_CSV_HEADER).toBe('name,url,username,password,note')
  })

  it('쉼표·따옴표·개행이 든 값을 RFC4180 으로 escape 하고 파서로 되읽으면 값이 그대로다', () => {
    const rows: ExportRow[] = [
      row({ label: '쉼표, 있음', fields: { value: 'p,1' } }),
      row({ username: 'quote"user', fields: { value: 'say "hi"' }, note: '줄1\n줄2' }),
      row({ username: 'plain', fields: { value: 'simple' }, note: '' })
    ]
    const csv = buildCsv(rows)
    const parsed = parsePasswordCsv(csv)

    expect(parsed.skipped).toBe(0)
    expect(parsed.rows).toHaveLength(rows.length)
    expect(parsed.rows[0].name).toBe('쉼표, 있음')
    expect(parsed.rows[0].password).toBe('p,1')
    expect(parsed.rows[1].username).toBe('quote"user')
    expect(parsed.rows[1].password).toBe('say "hi"')
    expect(parsed.rows[1].note).toBe('줄1\n줄2')
    expect(parsed.rows[2].password).toBe('simple')
  })
})

describe('buildJson', () => {
  it('{version, exportedAt, items:[{type,label,host,username,fields}]} 모양이다', () => {
    const json: unknown = JSON.parse(buildJson([row()], 1_700_000_000_000))
    expect(json).toMatchObject({
      version: 1,
      exportedAt: new Date(1_700_000_000_000).toISOString(),
      items: [
        {
          type: 'login',
          label: '예시',
          host: 'example.com',
          username: 'user1',
          fields: { value: 'pass1' }
        }
      ]
    })
  })
})

describe('exportVault', () => {
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

  it('금고가 잠겨 있으면 locked 로 거부한다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')
    vault.lock()

    const deps = makeDeps(vault)
    await expect(exportVault(deps, { format: 'csv', master: MASTER })).rejects.toThrow('locked')
    expect(deps.written.size).toBe(0)
    expect(deps.prompts).toHaveLength(0)
  })

  it('마스터 비밀번호가 틀리면 invalid-master 로 거부하고 파일을 만들지 않는다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')

    const deps = makeDeps(vault)
    await expect(exportVault(deps, { format: 'csv', master: '틀린비번' })).rejects.toThrow(
      'invalid-master'
    )
    expect(deps.written.size).toBe(0)
    expect(deps.prompts).toHaveLength(0)
    expect(vault.listAudit().filter((a) => a.action === 'export')).toHaveLength(0)
  })

  it('CSV 로 내보낸 뒤 가져오기 파서로 되읽으면 항목 수가 일치한다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')
    seedLogin(vault, 'shop.example.org', 'user2', 'p,a"ss2')

    const deps = makeDeps(vault)
    const result = await exportVault(deps, { format: 'csv', master: MASTER })

    expect(result.itemCount).toBe(2)
    expect(result.filePath).toBe('C:/tmp/keymaster.csv')
    const csv = deps.written.get('C:/tmp/keymaster.csv') ?? ''
    const parsed = parsePasswordCsv(csv)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows.map((r) => r.password).sort()).toEqual(['p,a"ss2', 'pass1'])
  })

  it('성공하면 감사 로그에 export 가 1건 남는다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')

    await exportVault(makeDeps(vault), { format: 'json', master: MASTER })
    expect(vault.listAudit().filter((a) => a.action === 'export')).toHaveLength(1)
  })

  it('저장 다이얼로그를 취소하면 파일도 감사 로그도 남지 않는다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')

    const deps = makeDeps(vault, null)
    await expect(exportVault(deps, { format: 'csv', master: MASTER })).rejects.toThrow('cancelled')
    expect(deps.written.size).toBe(0)
    expect(vault.listAudit().filter((a) => a.action === 'export')).toHaveLength(0)
  })

  it('저장 다이얼로그에 평문 경고 문구가 고정으로 실린다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')

    const deps = makeDeps(vault)
    await exportVault(deps, { format: 'csv', master: MASTER })
    const prompt = deps.prompts[0] as { message: string; nameFieldLabel: string }
    expect(prompt.message).toContain('평문')
    expect(prompt.nameFieldLabel).toContain('평문')
  })

  it('JSON 내보내기는 계정에 딸리지 않은 전역 항목도 포함한다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')
    vault.putItem({ accountId: null, type: 'note', label: '메모', value: '비밀 메모' })

    const deps = makeDeps(vault, 'C:/tmp/keymaster.json')
    const result = await exportVault(deps, { format: 'json', master: MASTER })

    expect(result.itemCount).toBe(2)
    const parsed = JSON.parse(deps.written.get('C:/tmp/keymaster.json') ?? '{}') as {
      items: { type: string; fields: Record<string, string> }[]
    }
    const note = parsed.items.find((i) => i.type === 'note')
    expect(note?.fields.value).toBe('비밀 메모')
  })

  it('CSV 는 비밀번호가 없는 항목(카드·메모)을 제외한다', async () => {
    await vault.setup(MASTER)
    seedLogin(vault, 'example.com', 'user1', 'pass1')
    vault.putItem({ accountId: null, type: 'note', label: '메모', value: '비밀 메모' })

    const deps = makeDeps(vault)
    const result = await exportVault(deps, { format: 'csv', master: MASTER })
    expect(result.itemCount).toBe(1)
    expect(parsePasswordCsv(deps.written.get('C:/tmp/keymaster.csv') ?? '').rows).toHaveLength(1)
  })
})

describe('VaultService.verifyMaster', () => {
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

  it('맞는 마스터 비밀번호는 true, 틀리면 false, 잠겨 있으면 false 다', async () => {
    await vault.setup(MASTER)
    expect(await vault.verifyMaster(MASTER)).toBe(true)
    expect(await vault.verifyMaster('nope')).toBe(false)
    vault.lock()
    expect(await vault.verifyMaster(MASTER)).toBe(false)
  })
})

describe('writeOwnerOnlyFile', () => {
  // New-M4 — writeFile 의 mode 는 파일을 새로 만들 때만 적용된다.
  // 이미 있는 파일에 덮어쓰면 예전 권한이 남아, 평문 파일이 남에게 읽힐 수 있다
  function makeFs(): OwnerOnlyFs & { calls: string[]; modes: number[] } {
    const calls: string[] = []
    const modes: number[] = []
    return {
      calls,
      modes,
      writeFile: async (_path, _content, options) => {
        calls.push('write')
        modes.push(options.mode)
      },
      chmod: async (_path, mode) => {
        calls.push('chmod')
        modes.push(mode)
      }
    }
  }

  it('쓰고 나서 권한을 0o600 으로 다시 조인다', async () => {
    const fs = makeFs()
    await writeOwnerOnlyFile('C:/tmp/export.csv', '내용', fs)
    expect(fs.calls).toEqual(['write', 'chmod'])
    expect(fs.modes).toEqual([0o600, 0o600])
  })

  it('권한 변경이 실패해도 내보내기를 실패시키지 않는다', async () => {
    const fs = makeFs()
    fs.chmod = async () => {
      throw new Error('권한 변경 불가')
    }
    await expect(writeOwnerOnlyFile('C:/tmp/export.csv', '내용', fs)).resolves.toBeUndefined()
  })
})
