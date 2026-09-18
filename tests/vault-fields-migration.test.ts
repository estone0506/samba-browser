// 금고 v1 → v2 데이터 마이그레이션 검증.
// 합성 v1 DB(옛 종류 3건 + sites.login_url)를 만들고, 변환 후
// 종류 매핑·fields 구조·복호화 왕복·계정 URL 이월·재실행 안전성을 확인한다.

import { describe, it, expect } from 'vitest'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { runMigrations } from '../src/main/db/migrate'
import { migrateVaultV2, mapLegacyType } from '../src/main/db/migrate-vault-v2'
import { parseFields, findField, aadFor, isSecretField } from '../src/main/vault/fields'
import { encrypt, decrypt, randomBytes } from '../src/main/vault/crypto'

async function makeV1Db(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve(`sql.js/dist/${f}`) })
  const db = new SQL.Database()
  // 컬럼 스키마는 최신(0004 포함)까지 올리고, 데이터만 v1 모양으로 넣는다
  runMigrations(db)
  return db
}

// v1 항목 한 건을 넣는다. AAD 는 v1 규칙(String(id)) 이라 insert 후 암호문을 채운다
function insertV1Item(
  db: SqlJsDatabase,
  key: Buffer,
  accountId: number | null,
  type: string,
  label: string,
  plaintext: string
): number {
  db.run(
    'INSERT INTO vault_items (account_id, type, label, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [accountId, type, label, new Uint8Array(0), new Uint8Array(0), Date.now()]
  )
  const id = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0])
  const blob = encrypt(key, plaintext, String(id))
  db.run('UPDATE vault_items SET ciphertext = ?, iv = ? WHERE id = ?', [
    new Uint8Array(blob.ciphertext),
    new Uint8Array(blob.iv),
    id
  ])
  return id
}

describe('mapLegacyType', () => {
  it('9종을 6종으로 접는다', () => {
    expect(mapLegacyType('login_password')).toBe('login')
    expect(mapLegacyType('payment_password')).toBe('password')
    expect(mapLegacyType('card')).toBe('card')
    expect(mapLegacyType('passport')).toBe('identity')
    expect(mapLegacyType('id_card')).toBe('identity')
    expect(mapLegacyType('birth_date')).toBe('identity')
    expect(mapLegacyType('address')).toBe('identity')
    expect(mapLegacyType('phone')).toBe('identity')
    expect(mapLegacyType('custom')).toBe('note')
  })

  it('이미 새 종류면 그대로 둔다', () => {
    expect(mapLegacyType('login')).toBe('login')
    expect(mapLegacyType('identity')).toBe('identity')
  })
})

describe('migrateVaultV2', () => {
  it('종류 변환·fields 이관·복호화 왕복·계정 URL 이월이 모두 성공한다', async () => {
    const db = await makeV1Db()
    const key = randomBytes(32)

    db.run('INSERT INTO sites (host, name, login_url, created_at) VALUES (?, ?, ?, ?)', [
      'example.com',
      'Example',
      'https://example.com/login',
      Date.now()
    ])
    const siteId = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0])
    db.run(
      'INSERT INTO accounts (site_id, label, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [siteId, '내 계정', 'me@example.com', 1, Date.now(), Date.now()]
    )
    const accountId = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0])

    const loginId = insertV1Item(db, key, accountId, 'login_password', '로그인 비밀번호', 'pw-1234')
    const cardId = insertV1Item(db, key, null, 'card', '신한카드', '4111111111111111')
    const customId = insertV1Item(db, key, null, 'custom', '메모', '기타 메모')

    const result = migrateVaultV2(db)
    expect(result.ok).toBe(true)
    expect(result.alreadyDone).toBe(false)
    expect(result.convertedItems).toBe(3)

    const rows = db.exec('SELECT id, type, fields FROM vault_items ORDER BY id')[0].values
    const byId = new Map(rows.map((r) => [Number(r[0]), { type: String(r[1]), fields: r[2] }]))
    expect(byId.get(loginId)?.type).toBe('login')
    expect(byId.get(cardId)?.type).toBe('card')
    expect(byId.get(customId)?.type).toBe('note')

    // fields[0] 은 secret 이고, v1 암호문을 재암호화 없이 그대로 들고 있다
    const sections = parseFields(String(byId.get(loginId)?.fields))
    expect(sections).toHaveLength(1)
    const field = findField(sections, 'value')
    expect(field).not.toBeNull()
    expect(field && isSecretField(field)).toBe(true)
    if (!field || !isSecretField(field)) throw new Error('secret 필드가 아님')
    expect(field.aad).toBe(String(loginId))

    const plain = decrypt(
      key,
      Buffer.from(field.ciphertext, 'base64'),
      Buffer.from(field.iv, 'base64'),
      aadFor(loginId, field)
    )
    expect(plain).toBe('pw-1234')

    // sites.login_url 이 accounts.urls 로 이월된다
    const urls = db.exec('SELECT urls FROM accounts WHERE id = ?', [accountId])[0].values[0][0]
    expect(JSON.parse(String(urls))).toEqual(['https://example.com/login'])

    db.close()
  })

  it('재실행해도 중복 변환하지 않는다(idempotent)', async () => {
    const db = await makeV1Db()
    const key = randomBytes(32)
    insertV1Item(db, key, null, 'passport', '여권', 'M12345678')

    const first = migrateVaultV2(db)
    expect(first.convertedItems).toBe(1)
    const fieldsAfterFirst = String(db.exec('SELECT fields FROM vault_items')[0].values[0][0])

    const second = migrateVaultV2(db)
    expect(second.alreadyDone).toBe(true)
    expect(second.convertedItems).toBe(0)
    const fieldsAfterSecond = String(db.exec('SELECT fields FROM vault_items')[0].values[0][0])
    expect(fieldsAfterSecond).toBe(fieldsAfterFirst)

    db.close()
  })

  it('빈 암호문(중단된 placeholder) 항목은 값 없는 항목으로 남긴다', async () => {
    const db = await makeV1Db()
    db.run(
      'INSERT INTO vault_items (account_id, type, label, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [null, 'custom', '빈 항목', new Uint8Array(0), new Uint8Array(0), Date.now()]
    )
    expect(migrateVaultV2(db).ok).toBe(true)
    const fields = String(db.exec('SELECT fields FROM vault_items')[0].values[0][0])
    expect(parseFields(fields)).toEqual([])
    db.close()
  })
})
