// 작업공간(브라우저 프로필) — 북마크·금고 항목을 가르는 상위 계층.
// 활성 작업공간 id 는 DB 가 아니라 설정(activeWorkspaceId)에 둔다. 기기마다 다를 수 있어
// 동기화 대상이 아니기 때문이다.
//
// workspaces 표 자체는 2b 에서 동기화하지 않는다(2c 예정) — SYNC_TABLES 에 없고,
// 원격 uuid 도 PC 마다 따로 만들어져(connect.workspaceRemoteId) 서로 다르다.
// 그래서 remote_id 컬럼은 2b 동안 항상 null 이다.

import { asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { workspaces } from '../db/schema'
import type { Settings } from '../../shared/settings'
import type { WorkspaceDto, WorkspaceScope } from '../../shared/sync'

/** Ctrl+Alt+1~9 로 고를 수 있는 최대 개수 */
export const MAX_WORKSPACES = 9

/** 첫 실행 때 자동으로 만들어지는 작업공간 이름 */
export const DEFAULT_WORKSPACE_NAME = '기본'

/** SettingsStore 중 이 서비스가 쓰는 부분만 (테스트에서 흉내내기 쉽도록 좁게 잡는다) */
export interface SettingsWriter {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
}

interface WorkspaceRow {
  id: number
  remoteId: string | null
  name: string
  color: string | null
  position: number
  deletedAt: number | null
}

export class WorkspaceService {
  private listeners: Array<(w: WorkspaceDto) => void> = []

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsWriter
  ) {}

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  /** 살아 있는(tombstone 이 아닌) 행을 position → id 순으로 읽는다 */
  private rows(): WorkspaceRow[] {
    return this.d
      .select({
        id: workspaces.id,
        remoteId: workspaces.remoteId,
        name: workspaces.name,
        color: workspaces.color,
        position: workspaces.position,
        deletedAt: workspaces.deletedAt
      })
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(asc(workspaces.position), asc(workspaces.id))
      .all()
  }

  private toDto(row: WorkspaceRow, activeId: number): WorkspaceDto {
    return {
      id: row.id,
      remoteId: row.remoteId,
      name: row.name,
      color: row.color,
      position: row.position,
      isActive: row.id === activeId
    }
  }

  /**
   * 설정에 적힌 활성 id 를 검증해 돌려준다. 그 작업공간이 사라졌거나 아직 정해지지
   * 않았으면 남은 것 중 첫 번째로 되돌리고 설정도 함께 고친다.
   * 작업공간이 하나도 없으면 0 을 돌려준다(아직 ensureDefault 전).
   */
  private resolveActiveId(rows: WorkspaceRow[]): number {
    const saved = this.settings.get().activeWorkspaceId
    if (rows.some((r) => r.id === saved)) return saved
    const first = rows[0]
    if (!first) return 0
    this.settings.set({ activeWorkspaceId: first.id })
    return first.id
  }

  list(): WorkspaceDto[] {
    const rows = this.rows()
    if (rows.length === 0) return []
    const activeId = this.resolveActiveId(rows)
    return rows.map((r) => this.toDto(r, activeId))
  }

  /** 작업공간이 하나도 없으면 '기본' 1개를 만들고 활성으로 삼는다 */
  ensureDefault(): WorkspaceDto {
    const rows = this.rows()
    if (rows.length > 0) {
      const activeId = this.resolveActiveId(rows)
      const current = rows.find((r) => r.id === activeId) ?? rows[0]
      return this.toDto(current, activeId)
    }
    const created = this.insert(DEFAULT_WORKSPACE_NAME, null, 0)
    this.settings.set({ activeWorkspaceId: created.id })
    return this.toDto(created, created.id)
  }

  /** 현재 활성 작업공간. 없으면 '기본' 을 만들어서라도 하나를 돌려준다 */
  active(): WorkspaceDto {
    return this.ensureDefault()
  }

  /** 활성 작업공간 id 만 필요한 호출부를 위한 지름길 */
  activeId(): number {
    return this.active().id
  }

  /**
   * 저장소(금고·북마크)에 넘길 조회 범위.
   * 첫 번째(기본) 작업공간에서만 작업공간 미지정(NULL) 행이 함께 보인다
   */
  scope(): WorkspaceScope {
    const current = this.active()
    const first = this.rows()[0]
    return { id: current.id, isDefault: first !== undefined && first.id === current.id }
  }

  private insert(name: string, color: string | null, position: number): WorkspaceRow {
    const now = Date.now()
    const inserted = this.d
      .insert(workspaces)
      .values({
        name,
        color,
        position,
        isActive: false,
        updatedAt: now,
        remoteId: null,
        deletedAt: null
      })
      .returning({ id: workspaces.id })
      .all()
    this.db.scheduleSave()
    return {
      id: inserted[0].id,
      remoteId: null,
      name,
      color,
      position,
      deletedAt: null
    }
  }

  create(name: string, color?: string): WorkspaceDto {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('작업공간 이름이 비어 있습니다')
    const rows = this.rows()
    if (rows.length >= MAX_WORKSPACES)
      throw new Error(`작업공간은 최대 ${MAX_WORKSPACES}개까지 만들 수 있습니다`)
    const position = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.position)) + 1
    const created = this.insert(trimmed, color ?? null, position)
    return this.toDto(created, this.resolveActiveId([...rows, created]))
  }

  rename(id: number, name: string): WorkspaceDto {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('작업공간 이름이 비어 있습니다')
    const rows = this.rows()
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error('작업공간을 찾을 수 없습니다')
    this.d.update(workspaces).set({ name: trimmed, updatedAt: Date.now() }).where(eqId(id)).run()
    this.db.scheduleSave()
    const next = { ...row, name: trimmed }
    const activeId = this.resolveActiveId(rows)
    const dto = this.toDto(next, activeId)
    if (dto.isActive) this.emit(dto)
    return dto
  }

  /** 삭제는 행을 지우지 않고 deletedAt 을 세운다(tombstone). 마지막 1개는 지울 수 없다 */
  remove(id: number): void {
    const rows = this.rows()
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error('작업공간을 찾을 수 없습니다')
    if (rows.length <= 1) throw new Error('마지막 작업공간은 삭제할 수 없습니다')
    const now = Date.now()
    this.d.update(workspaces).set({ deletedAt: now, updatedAt: now }).where(eqId(id)).run()
    this.db.scheduleSave()
    // 지운 것이 활성이었으면 남은 것 중 첫 번째로 옮긴다
    if (this.settings.get().activeWorkspaceId === id) {
      const remaining = rows.filter((r) => r.id !== id)
      const first = remaining[0]
      this.settings.set({ activeWorkspaceId: first.id })
      this.emit(this.toDto(first, first.id))
    }
  }

  switchTo(id: number): WorkspaceDto {
    const rows = this.rows()
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error('작업공간을 찾을 수 없습니다')
    const changed = this.settings.get().activeWorkspaceId !== id
    this.settings.set({ activeWorkspaceId: id })
    const dto = this.toDto(row, id)
    if (changed) this.emit(dto)
    return dto
  }

  /** Ctrl+Alt+1~9 용. index 는 1 부터 시작하는 position 순번이다 */
  switchToIndex(index: number): WorkspaceDto | null {
    if (!Number.isInteger(index) || index < 1 || index > MAX_WORKSPACES) return null
    const row = this.rows()[index - 1]
    if (!row) return null
    return this.switchTo(row.id)
  }

  /** 탭 세션 파티션 접두사. 작업공간마다 쿠키·로그인 세션이 갈린다 */
  partitionPrefix(): string {
    return `persist:ws${this.active().id}-`
  }

  onChanged(fn: (w: WorkspaceDto) => void): void {
    this.listeners.push(fn)
  }

  private emit(w: WorkspaceDto): void {
    for (const fn of this.listeners) {
      try {
        fn(w)
      } catch (e) {
        console.error('작업공간 변경 통지 실패', e)
      }
    }
  }
}

// id 조건은 어디서나 같으므로 짧은 도우미로 묶는다
function eqId(id: number): ReturnType<typeof eq> {
  return eq(workspaces.id, id)
}
