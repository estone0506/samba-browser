import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MOUSE_GESTURES,
  GESTURE_ACTIONS,
  GESTURE_SEQUENCES,
  defaultMouseGestures,
  gestureArrows,
  isGestureAction,
  resolveGestureAction,
  type GestureAction
} from '../src/shared/gestures'
import {
  GESTURE_MAX_STEPS,
  GESTURE_MIN_MOVE,
  sequenceFromPoints,
  type GesturePoint
} from '../src/preload/page-gesture'
import {
  ClosedTabStack,
  CLOSED_TAB_LIMIT,
  runGesture,
  type GestureDeps
} from '../src/main/browser/gestures'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'

// 시작점에서 상대 좌표로 포인트 열을 만든다(픽셀 단위 이동을 잘게 쪼개 실제 mousemove 처럼)
function path(...moves: Array<[number, number]>): GesturePoint[] {
  const points: GesturePoint[] = [{ x: 500, y: 500 }]
  for (const [dx, dy] of moves) {
    const last = points[points.length - 1]
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      points.push({ x: last.x + (dx * i) / steps, y: last.y + (dy * i) / steps })
    }
  }
  return points
}

describe('방향 시퀀스 인식', () => {
  it('최소 이동 거리에 못 미치면 아무 방향도 나오지 않는다', () => {
    expect(sequenceFromPoints(path([GESTURE_MIN_MOVE - 5, 0]))).toBe('')
    expect(sequenceFromPoints([])).toBe('')
    expect(sequenceFromPoints([{ x: 1, y: 1 }])).toBe('')
  })

  it('한 방향 4가지를 인식한다', () => {
    expect(sequenceFromPoints(path([-120, 0]))).toBe('L')
    expect(sequenceFromPoints(path([120, 0]))).toBe('R')
    expect(sequenceFromPoints(path([0, -120]))).toBe('U')
    expect(sequenceFromPoints(path([0, 120]))).toBe('D')
  })

  it('같은 방향이 이어져도 한 번만 쌓인다', () => {
    expect(sequenceFromPoints(path([-100, 0], [-100, 0], [-100, 0]))).toBe('L')
  })

  it('두 단계 제스처를 순서대로 쌓는다', () => {
    expect(sequenceFromPoints(path([0, 100], [100, 0]))).toBe('DR')
    expect(sequenceFromPoints(path([-100, 0], [0, -100]))).toBe('LU')
    expect(sequenceFromPoints(path([100, 0], [-100, 0]))).toBe('RL')
  })

  it('대각선 이동은 방향으로 인정하지 않는다', () => {
    // 45도로만 움직이면 주축/반대축 비율이 1 이라 계속 대기 상태다
    expect(sequenceFromPoints(path([200, 200]))).toBe('')
    // 대각선 뒤에 분명한 가로 이동이 이어지면 그때 한 방향이 잡힌다
    expect(sequenceFromPoints(path([60, 60], [200, 0]))).toBe('R')
  })

  it('최대 단계 수를 넘는 방향은 버린다', () => {
    const seq = sequenceFromPoints(
      path([-100, 0], [0, -100], [100, 0], [0, 100], [-100, 0], [0, -100])
    )
    expect(seq).toBe('LURD')
    expect(seq.length).toBe(GESTURE_MAX_STEPS)
  })
})

describe('기본 매핑', () => {
  it('웨일 기본 16종을 모두 담는다', () => {
    expect(GESTURE_SEQUENCES).toHaveLength(16)
    expect(Object.keys(DEFAULT_MOUSE_GESTURES).sort()).toEqual([...GESTURE_SEQUENCES].sort())
  })

  it('스크린샷 기준 기본값 그대로다', () => {
    expect(DEFAULT_MOUSE_GESTURES).toEqual({
      L: 'back',
      R: 'forward',
      U: 'scrollTop',
      D: 'scrollBottom',
      LR: 'home',
      RL: 'home',
      UD: 'reload',
      DU: 'reload',
      DL: 'newWindow',
      DR: 'newTab',
      LD: 'newProfileTab',
      RD: 'closeTab',
      UL: 'fullscreen',
      LU: 'reopenTab',
      UR: 'maximize',
      RU: 'minimize'
    })
  })

  it('기본값 복원은 매번 새 사본을 돌려준다', () => {
    const a = defaultMouseGestures()
    a.L = 'none'
    expect(DEFAULT_MOUSE_GESTURES.L).toBe('back')
    expect(defaultMouseGestures().L).toBe('back')
  })

  it('사용자 매핑이 기본값보다 우선하고, 깨진 값은 기본값으로 되돌린다', () => {
    expect(resolveGestureAction('L', { L: 'reload' })).toBe('reload')
    expect(resolveGestureAction('L', { L: 'nonsense' })).toBe('back')
    expect(resolveGestureAction('L', {})).toBe('back')
    // 기본값에도 없는 시퀀스(오인식)는 조용히 무시된다
    expect(resolveGestureAction('LRLR', {})).toBe('none')
    // 사용자가 일부러 끈 제스처는 그대로 'none'
    expect(resolveGestureAction('L', { L: 'none' })).toBe('none')
  })

  it('화살표 표기를 만든다', () => {
    expect(gestureArrows('L')).toBe('←')
    expect(gestureArrows('DR')).toBe('↓→')
    expect(gestureArrows('')).toBe('')
  })

  it('동작 이름 판정', () => {
    expect(isGestureAction('back')).toBe(true)
    expect(isGestureAction('nope')).toBe(false)
    expect(GESTURE_ACTIONS).toContain('none')
  })
})

// 모든 의존성을 기록형 스텁으로 대체한다(TabManager·BrowserWindow 없이 실행 경로만 본다)
function stubDeps(tabId: string | null = 'tab-1'): {
  deps: GestureDeps
  calls: string[]
} {
  const calls: string[] = []
  const log =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(args.length > 0 ? `${name}:${args.join(',')}` : name)
    }
  const deps: GestureDeps = {
    activeTabId: () => tabId,
    back: log('back'),
    forward: log('forward'),
    reload: log('reload'),
    navigate: async (id, url) => {
      calls.push(`navigate:${id},${url}`)
    },
    scrollTo: async (id, to) => {
      calls.push(`scrollTo:${id},${to}`)
    },
    homeUrl: () => 'https://home.example',
    newTab: log('newTab'),
    newWindow: log('newWindow'),
    newProfileTab: log('newProfileTab'),
    closeTab: log('closeTab'),
    reopenTab: log('reopenTab'),
    toggleFullScreen: log('toggleFullScreen'),
    maximize: log('maximize'),
    minimize: log('minimize')
  }
  return { deps, calls }
}

describe('동작 디스패치', () => {
  const cases: Array<[string, GestureAction, string]> = [
    ['L', 'back', 'back:tab-1'],
    ['R', 'forward', 'forward:tab-1'],
    ['U', 'scrollTop', 'scrollTo:tab-1,top'],
    ['D', 'scrollBottom', 'scrollTo:tab-1,bottom'],
    ['LR', 'home', 'navigate:tab-1,https://home.example'],
    ['RL', 'home', 'navigate:tab-1,https://home.example'],
    ['UD', 'reload', 'reload:tab-1'],
    ['DU', 'reload', 'reload:tab-1'],
    ['DL', 'newWindow', 'newWindow'],
    ['DR', 'newTab', 'newTab'],
    ['LD', 'newProfileTab', 'newProfileTab'],
    ['RD', 'closeTab', 'closeTab:tab-1'],
    ['UL', 'fullscreen', 'toggleFullScreen'],
    ['LU', 'reopenTab', 'reopenTab'],
    ['UR', 'maximize', 'maximize'],
    ['RU', 'minimize', 'minimize']
  ]

  for (const [sequence, action, call] of cases) {
    it(`${sequence} → ${action}`, async () => {
      const { deps, calls } = stubDeps()
      await expect(runGesture(sequence, DEFAULT_MOUSE_GESTURES, deps)).resolves.toBe(action)
      expect(calls).toEqual([call])
    })
  }

  it("'none' 이면 아무것도 실행하지 않는다", async () => {
    const { deps, calls } = stubDeps()
    await expect(runGesture('L', { L: 'none' }, deps)).resolves.toBe('none')
    expect(calls).toEqual([])
  })

  it('탭이 없으면 탭 동작을 조용히 넘기고, 창 동작은 그대로 실행한다', async () => {
    const noTab = stubDeps(null)
    await runGesture('L', DEFAULT_MOUSE_GESTURES, noTab.deps)
    expect(noTab.calls).toEqual([])

    const windowOnly = stubDeps(null)
    await runGesture('UR', DEFAULT_MOUSE_GESTURES, windowOnly.deps)
    expect(windowOnly.calls).toEqual(['maximize'])
  })

  it('사용자가 바꾼 매핑을 따른다', async () => {
    const { deps, calls } = stubDeps()
    await expect(runGesture('L', { ...DEFAULT_MOUSE_GESTURES, L: 'closeTab' }, deps)).resolves.toBe(
      'closeTab'
    )
    expect(calls).toEqual(['closeTab:tab-1'])
  })
})

describe('닫은 탭 스택', () => {
  it('마지막에 닫힌 것부터 돌려준다', () => {
    const stack = new ClosedTabStack()
    stack.push({ url: 'https://a.example', profile: 'default', mobile: false })
    stack.push({ url: 'https://b.example', profile: 'work', mobile: true })
    expect(stack.pop()).toEqual({ url: 'https://b.example', profile: 'work', mobile: true })
    expect(stack.pop()?.url).toBe('https://a.example')
    expect(stack.pop()).toBeNull()
  })

  it(`최대 ${CLOSED_TAB_LIMIT}개만 남기고 오래된 것부터 버린다`, () => {
    const stack = new ClosedTabStack()
    for (let i = 0; i < CLOSED_TAB_LIMIT + 5; i++) {
      stack.push({ url: `https://e.example/${i}`, profile: 'default', mobile: false })
    }
    expect(stack.size()).toBe(CLOSED_TAB_LIMIT)
    expect(stack.list()[0].url).toBe('https://e.example/5')
  })

  it('빈 탭은 쌓지 않는다', () => {
    const stack = new ClosedTabStack()
    stack.push({ url: '', profile: 'default', mobile: false })
    stack.push({ url: 'about:blank', profile: 'default', mobile: false })
    expect(stack.size()).toBe(0)
  })

  it('다시 열기는 스택이 비어 있으면 탭을 만들지 않는다', async () => {
    const stack = new ClosedTabStack()
    const created: string[] = []
    const { deps } = stubDeps()
    const reopening: GestureDeps = {
      ...deps,
      reopenTab: () => {
        const last = stack.pop()
        if (last) created.push(last.url)
      }
    }
    await runGesture('LU', DEFAULT_MOUSE_GESTURES, reopening)
    expect(created).toEqual([])
    stack.push({ url: 'https://again.example', profile: 'default', mobile: false })
    await runGesture('LU', DEFAULT_MOUSE_GESTURES, reopening)
    expect(created).toEqual(['https://again.example'])
  })
})

describe('설정 저장', () => {
  it('기본 설정에 제스처가 켜진 채로 들어 있다', () => {
    expect(DEFAULT_SETTINGS.mouseGesturesEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.mouseGestures).toEqual(DEFAULT_MOUSE_GESTURES)
  })

  it('알 수 없는 동작이 섞이면 표 전체를 기본값으로 되돌린다', () => {
    const s = parseSettings({ ...DEFAULT_SETTINGS, mouseGestures: { L: 'launch-missiles' } })
    expect(s.mouseGestures).toEqual(DEFAULT_MOUSE_GESTURES)
  })

  it('정상 매핑은 그대로 살아남는다', () => {
    const s = parseSettings({ ...DEFAULT_SETTINGS, mouseGestures: { L: 'reload' } })
    expect(s.mouseGestures).toEqual({ L: 'reload' })
    expect(resolveGestureAction('R', s.mouseGestures)).toBe('forward')
  })

  it('동기화 대상 키에 들어 있다', () => {
    const keys: readonly string[] = SYNCED_SETTING_KEYS
    expect(keys).toContain('mouseGesturesEnabled')
    expect(keys).toContain('mouseGestures')
  })
})

describe('설정 화면 문구', () => {
  it('ko/en 모두 모든 동작 이름을 갖는다', () => {
    const koActions: Record<string, string> = ko.settingsPage.gestures.actions
    const enActions: Record<string, string> = en.settingsPage.gestures.actions
    for (const action of GESTURE_ACTIONS) {
      expect(koActions[action], `ko:${action}`).toBeTruthy()
      expect(enActions[action], `en:${action}`).toBeTruthy()
    }
  })

  it('카드 제목·기본값 복원 문구가 있다', () => {
    for (const bundle of [ko, en]) {
      expect(bundle.settingsPage.gestures.title).toBeTruthy()
      expect(bundle.settingsPage.gestures.enable).toBeTruthy()
      expect(bundle.settingsPage.gestures.restore).toBeTruthy()
    }
  })
})
