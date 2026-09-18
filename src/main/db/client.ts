import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { drizzle, type SQLJsDatabase as DrizzleSqlJsDatabase } from 'drizzle-orm/sql-js'
import * as schema from './schema'
import { runMigrations } from './migrate'
import { migrateVaultV2 } from './migrate-vault-v2'

export interface Db {
  drizzle: DrizzleSqlJsDatabase<typeof schema>
  // 디바운스 없이 즉시 저장(파일 없으면 아무것도 하지 않음)
  save: () => void
  // 300ms 뒤 저장을 예약. 그 사이 또 호출되면 타이머를 미룬다(여러 쓰기를 한 번의 저장으로 묶음)
  scheduleSave: () => void
  close: () => void
  // close() 가 이미 실행됐는지. 종료 순서가 겹칠 때(예: before-quit 과 창 close 이벤트 모두)
  // 닫힌 sql.js 핸들에 쿼리를 날려 죽는 것을 막기 위해 호출부가 이걸로 먼저 확인한다
  readonly isClosed: boolean
}

const SAVE_DEBOUNCE_MS = 300

// sql.js 는 wasm 을 별도로 로드해야 한다. dev/빌드(externalized deps) 어느 쪽이든
// node_modules 안의 실제 wasm 파일 경로를 그대로 알려주면 동작하므로 require.resolve 를 쓴다
function locateWasm(file: string): string {
  return require.resolve(`sql.js/dist/${file}`)
}

// filePath 가 ':memory:' 면 파일을 전혀 건드리지 않는 메모리 DB 를 연다
export async function openDatabase(filePath: string): Promise<Db> {
  const isMemory = filePath === ':memory:'
  const SQL = await initSqlJs({ locateFile: locateWasm })

  const fileExisted = !isMemory && existsSync(filePath)
  const raw: SqlJsDatabase = fileExisted
    ? new SQL.Database(readFileSync(filePath))
    : new SQL.Database()

  runMigrations(raw)
  // 금고 v1 → v2 데이터 변환(1회). 실패해도 앱은 계속 뜬다(기능 저하, 크래시 금지)
  const vaultV2 = migrateVaultV2(raw)
  if (!vaultV2.ok) console.error('금고 v2 마이그레이션 실패', vaultV2.error)

  const db = drizzle(raw, { schema })

  // close() 가 raw.close() 직후 true 로 바뀐다. save 계열은 이후 즉시 no-op 이 된다
  let closed = false

  // sql.js export() → 임시 파일 → rename 으로 원자적으로 저장한다(쓰다 만 파일이 남지 않도록)
  const save = (): void => {
    if (isMemory || closed) return
    const tmpPath = `${filePath}.${randomUUID()}.tmp`
    const data = raw.export()
    writeFileSync(tmpPath, Buffer.from(data))
    try {
      renameSync(tmpPath, filePath)
    } catch (e: unknown) {
      // rename 실패 시 임시 파일이 남지 않게 정리
      try {
        unlinkSync(tmpPath)
      } catch {
        // 정리 실패는 무시 — 원래 에러를 그대로 던진다
      }
      throw e
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSave = (): void => {
    if (isMemory || closed) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      save()
    }, SAVE_DEBOUNCE_MS)
  }

  // 두 번 호출돼도 안전하다(예: before-quit 과 창 closed 이벤트 양쪽에서 종료 정리가 겹치는 경우)
  const close = (): void => {
    if (closed) return
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
      save()
    }
    raw.close()
    closed = true
  }

  // 새로 만든 파일 DB 는 마이그레이션 직후 바로 디스크에 써 둔다(첫 쓰기 전까지 파일이 없으면 혼란스러움)
  if (!isMemory && !fileExisted) save()

  return {
    drizzle: db,
    save,
    scheduleSave,
    close,
    get isClosed() {
      return closed
    }
  }
}
