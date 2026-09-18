// 금고 v1 → v2 데이터 마이그레이션(앱 시작 시 1회).
//
// 0004 마이그레이션이 컬럼만 추가하므로, 기존 데이터를 옮기는 일은 여기서 한다.
// - vault_items.type: 옛 9종 → 새 6종
// - vault_items.fields: 단일 ciphertext/iv → [{key:'value',kind:'secret',...,aad:String(id)}]
//   (재암호화하지 않는다. 옛 AAD 가 String(id) 라서 aad 를 그대로 적어 둔다)
// - accounts.urls: sites.login_url 을 계정별 URL 목록으로 복사
//
// 전부 한 트랜잭션이며, 실패하면 ROLLBACK 후 false 를 돌려준다(앱은 v1 동작으로 계속 — 크래시 금지).
// 비밀값 평문은 이 경로에 전혀 등장하지 않는다(암호문 바이트만 옮긴다).

import type { Database as SqlJsDatabase } from 'sql.js'
import { LEGACY_TYPE_MAP, normalizeItemType } from '../../shared/vault'
import {
  DEFAULT_FIELD_KEY,
  DEFAULT_SECTION_KEY,
  serializeFields,
  type StoredSection
} from '../vault/fields'

// 완료 플래그를 적어 두는 vault_meta 키(재실행 방지)
export const SCHEMA_V2_META_KEY = 'schema_v2_done'

export interface VaultV2MigrationResult {
  // 이미 끝나 있어서 아무 것도 하지 않았으면 true
  alreadyDone: boolean
  // 변환에 성공했는가(실패 시 롤백되고 false)
  ok: boolean
  convertedItems: number
  convertedAccounts: number
  error?: string
}

// 새 6종으로 정규화한다. 매핑표는 shared/vault 의 LEGACY_TYPE_MAP 한 곳에만 둔다
export function mapLegacyType(raw: string): string {
  return LEGACY_TYPE_MAP[raw] ?? normalizeItemType(raw)
}

function toBase64(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Buffer.isBuffer(value)) return value.toString('base64')
  return ''
}

/** v1 항목 한 건의 암호문을 v2 fields JSON 으로 옮긴다(재암호화 없음) */
export function buildLegacyFields(
  itemId: number,
  label: string,
  ciphertext: unknown,
  iv: unknown
): StoredSection[] {
  const ct = toBase64(ciphertext)
  const ivB64 = toBase64(iv)
  // 암호문이 비어 있으면(중단된 placeholder) 값 없는 항목으로 둔다
  if (!ct || !ivB64) return []
  return [
    {
      key: DEFAULT_SECTION_KEY,
      label,
      fields: [
        {
          key: DEFAULT_FIELD_KEY,
          label,
          kind: 'secret',
          ciphertext: ct,
          iv: ivB64,
          // v1 암호문의 AAD 는 항목 id 문자열이었다
          aad: String(itemId)
        }
      ]
    }
  ]
}

function isDone(db: SqlJsDatabase): boolean {
  const rows = db.exec('SELECT 1 FROM vault_meta WHERE key = ?', [SCHEMA_V2_META_KEY])
  return rows.length > 0 && rows[0].values.length > 0
}

/** 앱 시작 시 1회 호출. 이미 끝났으면 즉시 반환한다 */
export function migrateVaultV2(db: SqlJsDatabase): VaultV2MigrationResult {
  if (isDone(db)) {
    return { alreadyDone: true, ok: true, convertedItems: 0, convertedAccounts: 0 }
  }

  db.run('BEGIN TRANSACTION')
  try {
    let convertedItems = 0
    const items = db.exec(
      'SELECT id, type, label, fields, ciphertext, iv FROM vault_items ORDER BY id'
    )
    if (items.length > 0) {
      for (const row of items[0].values) {
        const id = Number(row[0])
        const type = String(row[1] ?? '')
        const label = String(row[2] ?? '')
        const existingFields = row[3]
        const nextType = mapLegacyType(type)
        // fields 가 이미 채워져 있으면 값은 건드리지 않고 종류만 맞춘다(부분 재실행 대비)
        if (typeof existingFields === 'string' && existingFields.length > 0) {
          if (nextType !== type) {
            db.run('UPDATE vault_items SET type = ? WHERE id = ?', [nextType, id])
            convertedItems += 1
          }
          continue
        }
        const sections = buildLegacyFields(id, label, row[4], row[5])
        db.run('UPDATE vault_items SET type = ?, fields = ? WHERE id = ?', [
          nextType,
          serializeFields(sections),
          id
        ])
        convertedItems += 1
      }
    }

    // sites.login_url → accounts.urls (아직 urls 가 비어 있는 계정만)
    let convertedAccounts = 0
    const accounts = db.exec(
      'SELECT a.id, s.login_url FROM accounts a JOIN sites s ON s.id = a.site_id'
    )
    if (accounts.length > 0) {
      for (const row of accounts[0].values) {
        const id = Number(row[0])
        const loginUrl = typeof row[1] === 'string' && row[1].length > 0 ? row[1] : null
        const urls = loginUrl ? [loginUrl] : []
        db.run("UPDATE accounts SET urls = ? WHERE id = ? AND (urls IS NULL OR urls = '')", [
          JSON.stringify(urls),
          id
        ])
        convertedAccounts += 1
      }
    }

    db.run('INSERT INTO vault_meta (key, value) VALUES (?, ?)', [
      SCHEMA_V2_META_KEY,
      // value 는 NOT NULL BLOB — 플래그이므로 내용은 의미 없다
      new Uint8Array([1])
    ])
    db.run('COMMIT')
    return { alreadyDone: false, ok: true, convertedItems, convertedAccounts }
  } catch (e: unknown) {
    try {
      db.run('ROLLBACK')
    } catch {
      // 롤백 실패까지 겹치면 할 수 있는 일이 없다 — 앱은 계속 뜬다
    }
    return {
      alreadyDone: false,
      ok: false,
      convertedItems: 0,
      convertedAccounts: 0,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
