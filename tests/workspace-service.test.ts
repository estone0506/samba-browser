import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { workspaces } from '../src/main/db/schema'
import { WorkspaceService, MAX_WORKSPACES } from '../src/main/workspace/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { workspaceShortcutIndex } from '../src/main/workspace/shortcut'
import type { WorkspaceDto } from '../src/shared/sync'

// SettingsStore 는 electron app 에 의존하므로 테스트에서는 최소 인터페이스만 흉내낸다
function makeSettings(patch: Partial<Settings> = {}): {
  get: () => Settings
  set: (p: Partial<Settings>) => Settings
} {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

describe('WorkspaceService', () => {
  let db: Db
  let settings: ReturnType<typeof makeSettings>
  let svc: WorkspaceService

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    settings = makeSettings()
    svc = new WorkspaceService(db, settings)
  })

  afterEach(() => {
    db.close()
  })

  it('ensureDefault 는 기본 작업공간 1개를 만들고 활성으로 삼는다', () => {
    const w = svc.ensureDefault()
    expect(w.name).toBe('기본')
    expect(w.isActive).toBe(true)
    expect(svc.list()).toHaveLength(1)
    expect(settings.get().activeWorkspaceId).toBe(w.id)
  })

  it('ensureDefault 를 두 번 불러도 1건만 남는다', () => {
    const a = svc.ensureDefault()
    const b = svc.ensureDefault()
    expect(a.id).toBe(b.id)
    expect(svc.list()).toHaveLength(1)
  })

  it('create 후 목록은 2건이고 활성 작업공간은 그대로다', () => {
    const base = svc.ensureDefault()
    const made = svc.create('업무', '#ff0000')
    expect(svc.list()).toHaveLength(2)
    expect(made.name).toBe('업무')
    expect(made.color).toBe('#ff0000')
    expect(svc.active().id).toBe(base.id)
  })

  it('switchTo 는 활성 작업공간을 바꾸고 onChanged 를 발화한다', () => {
    svc.ensureDefault()
    const made = svc.create('업무')
    const seen: WorkspaceDto[] = []
    svc.onChanged((w) => seen.push(w))
    const got = svc.switchTo(made.id)
    expect(got.id).toBe(made.id)
    expect(svc.active().id).toBe(made.id)
    expect(seen.map((w) => w.id)).toEqual([made.id])
  })

  it('switchToIndex 는 position 순 n 번째로 전환하고, 없는 번호는 null 이다', () => {
    svc.ensureDefault()
    const second = svc.create('업무')
    expect(svc.switchToIndex(2)?.id).toBe(second.id)
    expect(svc.switchToIndex(9)).toBeNull()
    expect(svc.switchToIndex(0)).toBeNull()
  })

  it('MAX_WORKSPACES 를 넘겨 만들면 예외가 난다', () => {
    svc.ensureDefault()
    for (let i = 2; i <= MAX_WORKSPACES; i++) svc.create(`작업공간 ${i}`)
    expect(svc.list()).toHaveLength(MAX_WORKSPACES)
    expect(() => svc.create('초과')).toThrow()
  })

  it('마지막 남은 작업공간은 삭제할 수 없다', () => {
    const only = svc.ensureDefault()
    expect(() => svc.remove(only.id)).toThrow()
  })

  it('remove 는 행을 지우지 않고 deletedAt 만 설정한다(tombstone)', () => {
    svc.ensureDefault()
    const made = svc.create('업무')
    svc.remove(made.id)
    expect(svc.list().map((w) => w.id)).not.toContain(made.id)
    const rows = db.drizzle.select().from(workspaces).all()
    const row = rows.find((r) => r.id === made.id)
    expect(row).toBeDefined()
    expect(row?.deletedAt).toBeTypeOf('number')
  })

  it('partitionPrefix 는 활성 작업공간 id 를 반영한다', () => {
    const base = svc.ensureDefault()
    expect(svc.partitionPrefix()).toBe(`persist:ws${base.id}-`)
    const made = svc.create('업무')
    svc.switchTo(made.id)
    expect(svc.partitionPrefix()).toBe(`persist:ws${made.id}-`)
  })

  it('활성 작업공간을 지우면 남은 것 중 첫 번째로 자동 전환한다', () => {
    const base = svc.ensureDefault()
    const made = svc.create('업무')
    svc.switchTo(made.id)
    svc.remove(made.id)
    expect(svc.active().id).toBe(base.id)
  })

  it('rename 은 이름을 바꾸고 빈 이름은 거부한다', () => {
    const base = svc.ensureDefault()
    expect(svc.rename(base.id, '개인').name).toBe('개인')
    expect(() => svc.rename(base.id, '   ')).toThrow()
  })

  it('활성 작업공간이 아직 없으면 list 조회만으로는 만들지 않는다', () => {
    expect(svc.list()).toHaveLength(0)
  })

  it('설정의 activeWorkspaceId 가 사라진 작업공간을 가리키면 첫 번째로 되돌린다', () => {
    const base = svc.ensureDefault()
    settings.set({ activeWorkspaceId: 999 })
    expect(svc.active().id).toBe(base.id)
  })

  it('scope 는 첫 번째 작업공간에서만 isDefault 가 참이다', () => {
    const base = svc.ensureDefault()
    expect(svc.scope()).toEqual({ id: base.id, isDefault: true })
    const made = svc.create('업무')
    svc.switchTo(made.id)
    expect(svc.scope()).toEqual({ id: made.id, isDefault: false })
  })
})

describe('workspaceShortcutIndex', () => {
  const base = { type: 'keyDown', key: '1', control: true, alt: true, shift: false, meta: false }

  it('Ctrl+Alt+1~9 는 번호를 돌려준다', () => {
    expect(workspaceShortcutIndex(base)).toBe(1)
    expect(workspaceShortcutIndex({ ...base, key: '9' })).toBe(9)
  })

  it('keyUp·다른 조합키·숫자가 아닌 키는 받지 않는다', () => {
    expect(workspaceShortcutIndex({ ...base, type: 'keyUp' })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, shift: true })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, meta: true })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, alt: false })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, control: false })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, key: '0' })).toBeNull()
    expect(workspaceShortcutIndex({ ...base, key: 'a' })).toBeNull()
  })
})
