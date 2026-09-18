// 변경 로그(sync_outbox) — 로컬 쓰기마다 한 줄씩 쌓이고, 푸시가 성공하면 지워진다.
// 오프라인이어도 쌓아 두었다가 재연결 시 그대로 전송한다.
// 값(평문)은 절대 담지 않는다. payload 는 삭제된 행의 원격 id 처럼 "나중에 다시 읽을 수 없는"
// 최소 정보만 담는다

import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { syncOutbox } from '../db/schema'
import { SYNC_TABLES, type SyncOp, type SyncTable } from '../../shared/sync'

export interface OutboxRow {
  id: number
  table: SyncTable
  rowId: string
  op: SyncOp
  payload: string | null
  createdAt: number
  triedAt: number | null
  error: string | null
}

const DEFAULT_PENDING_LIMIT = 500

function isSyncTable(value: string): value is SyncTable {
  return (SYNC_TABLES as readonly string[]).includes(value)
}

function isSyncOp(value: string): value is SyncOp {
  return value === 'upsert' || value === 'delete'
}

export class SyncOutbox {
  constructor(private readonly db: Db) {}

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  /**
   * 변경 한 건을 기록한다.
   * 같은 (table,rowId) 의 기존 행을 먼저 지우고 새로 넣는다 — 전송할 때 어차피 로컬 행을
   * 다시 읽으므로 중간 상태를 여러 줄 들고 있을 이유가 없다(삭제가 마지막이면 삭제만 남는다)
   */
  record(table: SyncTable, rowId: string, op: SyncOp, payload?: string): void {
    this.d
      .delete(syncOutbox)
      .where(and(eq(syncOutbox.table, table), eq(syncOutbox.rowId, rowId)))
      .run()
    this.d
      .insert(syncOutbox)
      .values({
        table,
        rowId,
        op,
        payload: payload ?? null,
        createdAt: Date.now()
      })
      .run()
    this.db.scheduleSave()
  }

  /** 아직 보내지 못한 변경을 오래된 순으로 돌려준다 */
  pending(limit: number = DEFAULT_PENDING_LIMIT): OutboxRow[] {
    return this.d
      .select()
      .from(syncOutbox)
      .orderBy(asc(syncOutbox.id))
      .limit(limit)
      .all()
      .flatMap(toOutboxRow)
  }

  /** 표 하나의 대기 건만 돌려준다(푸시는 표 단위로 돈다) */
  pendingFor(table: SyncTable, limit: number = DEFAULT_PENDING_LIMIT): OutboxRow[] {
    return this.d
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.table, table))
      .orderBy(asc(syncOutbox.id))
      .limit(limit)
      .all()
      .flatMap(toOutboxRow)
  }

  count(): number {
    return this.d.select({ id: syncOutbox.id }).from(syncOutbox).all().length
  }

  /** 전송에 성공한 건을 지운다 */
  clear(ids: number[]): void {
    if (ids.length === 0) return
    this.d.delete(syncOutbox).where(inArray(syncOutbox.id, ids)).run()
    this.db.scheduleSave()
  }

  /** 전송에 실패한 건을 남겨 두고 사유만 적는다. 다음 주기에 다시 시도한다 */
  markFailed(ids: number[], error: string): void {
    if (ids.length === 0) return
    this.d
      .update(syncOutbox)
      .set({ triedAt: Date.now(), error })
      .where(inArray(syncOutbox.id, ids))
      .run()
    this.db.scheduleSave()
  }
}

// 표·연산 이름이 우리가 아는 값이 아니면(옛 버전·손상) 조용히 버린다 — 전송 경로를 더럽히지 않는다
function toOutboxRow(r: typeof syncOutbox.$inferSelect): OutboxRow[] {
  if (!isSyncTable(r.table) || !isSyncOp(r.op)) return []
  return [
    {
      id: r.id,
      table: r.table,
      rowId: r.rowId,
      op: r.op,
      payload: r.payload,
      createdAt: r.createdAt,
      triedAt: r.triedAt,
      error: r.error
    }
  ]
}
