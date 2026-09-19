// 변경 로그(sync_outbox) — 로컬 쓰기마다 한 줄씩 쌓이고, 푸시가 성공하면 지워진다.
// 오프라인이어도 쌓아 두었다가 재연결 시 그대로 전송한다.
// 값(평문)은 절대 담지 않는다. payload 는 삭제된 행의 원격 id 처럼 "나중에 다시 읽을 수 없는"
// 최소 정보만 담는다

import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { syncOutbox } from '../db/schema'
import { SYNC_TABLES, type OutboxRecorder, type SyncOp, type SyncTable } from '../../shared/sync'
import { SyncLocal } from './local'

export interface OutboxRow {
  id: number
  table: SyncTable
  rowId: string
  op: SyncOp
  payload: string | null
  createdAt: number
  triedAt: number | null
  error: string | null
  /** 이 변경이 일어난 작업공간(로컬 id). 옛 행은 null — 푸시가 활성 작업공간으로 본다 */
  workspaceId: number | null
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
  record(
    table: SyncTable,
    rowId: string,
    op: SyncOp,
    payload?: string,
    workspaceId?: number | null
  ): void {
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
        createdAt: Date.now(),
        workspaceId: workspaceId ?? null
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

  /**
   * 아직 보내지 않은 설정 키 항목을 지운다. 키 재료 불일치 주기에 로컬 salt/verifier 가
   * 첫 PC 의 값을 덮지 않도록 푸시 전에 걷어낸다(4차 리뷰 N1). 지운 개수를 돌려준다
   */
  dropPendingSettingKeys(keys: readonly string[]): number {
    if (keys.length === 0) return 0
    const rows = this.d
      .select({ id: syncOutbox.id })
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table, 'settings'), inArray(syncOutbox.rowId, [...keys])))
      .all()
    if (rows.length === 0) return 0
    this.d
      .delete(syncOutbox)
      .where(
        inArray(
          syncOutbox.id,
          rows.map((r) => r.id)
        )
      )
      .run()
    this.db.scheduleSave()
    return rows.length
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

/**
 * 쓰기 지점에 주입할 기록 훅을 만든다.
 *
 * 삭제(op='delete')는 **행을 지우기 전에** 불러야 한다 — 여기서 로컬 행을 스냅샷으로 떠
 * payload 에 담아 두어야, 나중에 원격에 삭제 표식(tombstone)을 올릴 수 있다.
 * (원격 표의 host·label·url 은 NOT NULL 이라 원격 id 만으로는 표식을 만들 수 없다)
 */
export function createOutboxRecorder(
  db: Db,
  outbox: SyncOutbox,
  // 기록 시점의 활성 작업공간(로컬 id). 주지 않으면 작업공간을 남기지 않는다(테스트용 최소 호출)
  workspaceId: () => number | null = () => null
): OutboxRecorder {
  const local = new SyncLocal(db)
  return (table, rowId, op, payload) => {
    const workspace = workspaceId()
    if (table === 'settings') {
      // 설정은 DB 밖(config.json)에 있어 수정 시각이 없다. 여기서 대신 찍어 둔다
      local.setStateNumber(settingUpdatedAtKey(rowId), Date.now())
      outbox.record(table, rowId, op, payload, workspace)
      return
    }
    if (op !== 'delete' || payload !== undefined) {
      outbox.record(table, rowId, op, payload, workspace)
      return
    }
    const snapshot = local.snapshotForDelete(table, Number(rowId))
    outbox.record(table, rowId, op, snapshot ? JSON.stringify(snapshot) : undefined, workspace)
  }
}

/** 설정 키의 마지막 수정 시각을 담는 sync_state 키 */
export function settingUpdatedAtKey(key: string): string {
  return `settings:${key}:updatedAt`
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
      error: r.error,
      workspaceId: r.workspaceId
    }
  ]
}
