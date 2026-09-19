import { describe, it, expect, beforeEach } from 'vitest'
import { PlaybookStore, withBuiltins } from '../src/main/playbooks/store'
import {
  BUILTIN_UNFULFILLED_ID,
  PLAYBOOK_MAX_COUNT,
  PLAYBOOK_NAME_MAX,
  type PlaybookDto
} from '../src/shared/playbook'

// 설정 저장소 대역 — playbooks 한 칸만 들고 있으면 된다
function fakeSettings(): {
  get(): { playbooks: PlaybookDto[] }
  set(patch: { playbooks: PlaybookDto[] }): { playbooks: PlaybookDto[] }
} {
  let playbooks: PlaybookDto[] = []
  return {
    get: () => ({ playbooks }),
    set: (patch) => {
      playbooks = patch.playbooks
      return { playbooks }
    }
  }
}

let settings: ReturnType<typeof fakeSettings>
let store: PlaybookStore
let nextId = 0

beforeEach(() => {
  settings = fakeSettings()
  nextId = 0
  store = new PlaybookStore(
    settings,
    () => 1000,
    () => `id-${++nextId}`
  )
})

describe('목록과 내장 채우기', () => {
  it('처음 읽으면 내장 플레이북이 채워진다', () => {
    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(BUILTIN_UNFULFILLED_ID)
    // 채운 결과가 저장까지 됐는지
    expect(settings.get().playbooks).toHaveLength(1)
  })

  it('withBuiltins 는 이미 있는 내장을 중복으로 넣지 않는다', () => {
    const rows = store.list()
    expect(withBuiltins(rows, 1)).toHaveLength(1)
  })

  it('사용자가 고친 내장은 덮어쓰지 않는다', () => {
    store.put({
      id: BUILTIN_UNFULFILLED_ID,
      name: '내 절차',
      triggers: ['내 트리거'],
      instructions: '내가 쓴 절차',
      enabled: false
    })
    const row = store.list().find((p) => p.id === BUILTIN_UNFULFILLED_ID)
    expect(row?.name).toBe('내 절차')
    expect(row?.enabled).toBe(false)
    // builtin 표식은 사용자 입력으로 사라지지 않는다
    expect(row?.builtin).toBe(true)
  })
})

describe('CRUD', () => {
  it('새로 만들면 id 와 시각이 붙는다', () => {
    const created = store.put({
      name: '환불 처리',
      triggers: ['환불'],
      instructions: '절차',
      enabled: true
    })
    expect(created?.id).toBe('id-1')
    expect(created?.updatedAt).toBe(1000)
    expect(store.list()).toHaveLength(2)
  })

  it('이름이 비어 있으면 만들지 않는다', () => {
    expect(store.put({ name: '   ', triggers: [], instructions: '', enabled: true })).toBeNull()
  })

  it('트리거는 공백을 다듬고 빈 값·중복(대소문자 무시)을 버린다', () => {
    const created = store.put({
      name: '이름',
      triggers: [' 미이행 ', '', '미이행', 'ABC', 'abc'],
      instructions: '',
      enabled: true
    })
    expect(created?.triggers).toEqual(['미이행', 'ABC'])
  })

  it('이름은 상한 길이로 잘린다', () => {
    const created = store.put({
      name: 'ㄱ'.repeat(PLAYBOOK_NAME_MAX + 20),
      triggers: [],
      instructions: '',
      enabled: true
    })
    expect(created?.name).toHaveLength(PLAYBOOK_NAME_MAX)
  })

  it('없는 id 를 고치려 하면 null', () => {
    expect(
      store.put({ id: '없음', name: '이름', triggers: [], instructions: '', enabled: true })
    ).toBeNull()
  })

  it('개수 상한을 넘으면 새로 만들지 않는다', () => {
    for (let i = store.list().length; i < PLAYBOOK_MAX_COUNT; i += 1) {
      expect(
        store.put({ name: `p${i}`, triggers: [], instructions: '', enabled: true })
      ).not.toBeNull()
    }
    expect(store.put({ name: '넘침', triggers: [], instructions: '', enabled: true })).toBeNull()
  })

  it('사용자 플레이북은 지워진다', () => {
    const created = store.put({ name: '지울 것', triggers: [], instructions: '', enabled: true })
    expect(created).not.toBeNull()
    if (!created) return
    expect(store.remove(created.id)).toBe(true)
    expect(store.list().some((p) => p.id === created.id)).toBe(false)
  })

  it('내장 플레이북은 지워지지 않는다', () => {
    expect(store.remove(BUILTIN_UNFULFILLED_ID)).toBe(false)
    expect(store.list().some((p) => p.id === BUILTIN_UNFULFILLED_ID)).toBe(true)
  })

  it('없는 id 를 지우면 false', () => {
    expect(store.remove('없음')).toBe(false)
  })
})

describe('기본값 복원', () => {
  it('고쳐 둔 내장을 원래대로 되돌린다', () => {
    store.put({
      id: BUILTIN_UNFULFILLED_ID,
      name: '망가뜨린 이름',
      triggers: [],
      instructions: '',
      enabled: false
    })
    const restored = store.restore(BUILTIN_UNFULFILLED_ID)
    expect(restored?.name).toBe('삼바 미이행 주문 처리')
    expect(restored?.enabled).toBe(true)
    expect(restored?.triggers).toContain('삼바 미이행')
    expect(store.list().filter((p) => p.id === BUILTIN_UNFULFILLED_ID)).toHaveLength(1)
  })

  it('내장이 아닌 id 는 복원 대상이 아니다', () => {
    const created = store.put({ name: '내 것', triggers: [], instructions: '', enabled: true })
    expect(created).not.toBeNull()
    if (!created) return
    expect(store.restore(created.id)).toBeNull()
  })
})
