import type { Database as SqlJsDatabase } from 'sql.js'
import { migrations } from './migrations'

// 이미 적용된 마이그레이션을 기록해 두는 테이블. 재실행해도 같은 SQL 을 두 번 돌리지 않는다
const MIGRATIONS_TABLE = '__migrations'

function ensureMigrationsTable(db: SqlJsDatabase): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    tag TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
}

function appliedTags(db: SqlJsDatabase): Set<string> {
  const result = db.exec(`SELECT tag FROM ${MIGRATIONS_TABLE}`)
  const tags = new Set<string>()
  if (result.length > 0) {
    for (const row of result[0].values) {
      tags.add(String(row[0]))
    }
  }
  return tags
}

// drizzle/ 에서 생성돼 migrations.ts 에 번들된 SQL 을, 순서대로, 아직 적용되지 않은 것만 실행한다
export function runMigrations(db: SqlJsDatabase): void {
  ensureMigrationsTable(db)
  const applied = appliedTags(db)
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue
    // drizzle-kit generate 를 다시 돌려 태그 이름이 바뀐 경우(예: 0003_add_bookmark_folder_add_date
    // → 0003_bouncy_quasar), 옛 태그로 이미 적용된 DB 라면 같은 SQL 을 다시 돌리지 않고
    // 새 태그만 적용됨으로 기록한다
    const aliasApplied = migration.aliases?.some((tag) => applied.has(tag)) ?? false
    if (aliasApplied) {
      db.run(`INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`, [
        migration.tag,
        Date.now()
      ])
      continue
    }
    db.run('BEGIN TRANSACTION')
    try {
      for (const statement of migration.sql) {
        db.run(statement)
      }
      db.run(`INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`, [
        migration.tag,
        Date.now()
      ])
      db.run('COMMIT')
    } catch (e: unknown) {
      db.run('ROLLBACK')
      throw e
    }
  }
}
