import { describe, it, expect } from 'vitest'
import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_SHORTCUTS,
  MAX_FULL_PAGE_HEIGHT,
  captureExtension,
  captureFileName,
  captureShortcutMode,
  captureTimestamp,
  clampRect,
  fullPageHeight,
  fullPageSteps,
  matchesCaptureShortcut,
  mergeCaptureShortcuts,
  normalizeDragRect,
  parseCaptureElementRect,
  parseCaptureShortcut,
  type CaptureShortcutInput
} from '../src/shared/capture'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'

const keyDown = (key: string, mods: Partial<CaptureShortcutInput> = {}): CaptureShortcutInput => ({
  type: 'keyDown',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

describe('전체 페이지 이어붙이기 좌표 계산', () => {
  it('고정 헤더가 없으면 화면 높이만큼 잘라 이어 붙인다', () => {
    const steps = fullPageSteps({ totalHeight: 2500, viewportHeight: 1000, headerHeight: 0 })
    expect(steps.map((s) => s.scrollY)).toEqual([0, 1000, 1500])
    expect(steps.map((s) => s.sourceTop)).toEqual([0, 0, 500])
    expect(steps.map((s) => s.destTop)).toEqual([0, 1000, 2000])
    expect(steps.map((s) => s.height)).toEqual([1000, 1000, 500])
    expect(fullPageHeight(steps)).toBe(2500)
  })

  it('첫 장 이후에는 고정 헤더 높이만큼 위를 잘라낸다', () => {
    const steps = fullPageSteps({ totalHeight: 2400, viewportHeight: 800, headerHeight: 100 })
    expect(steps[0]).toEqual({ index: 0, scrollY: 0, sourceTop: 0, height: 800, destTop: 0 })
    // 두 번째 장은 800-100=700 으로 스크롤하고, 화면 위 100px(헤더)을 버린다
    expect(steps[1]).toEqual({ index: 1, scrollY: 700, sourceTop: 100, height: 700, destTop: 800 })
    expect(steps[2].scrollY).toBe(1400)
    expect(steps[2].sourceTop).toBe(100)
    // 이어 붙인 총 높이는 문서 높이와 정확히 같다
    expect(fullPageHeight(steps)).toBe(2400)
  })

  it('페이지 끝에서는 스크롤을 묶고 잘라낼 위치를 대신 늘린다', () => {
    const steps = fullPageSteps({ totalHeight: 1200, viewportHeight: 1000, headerHeight: 0 })
    expect(steps).toHaveLength(2)
    // 최대 스크롤은 1200-1000=200 이므로 두 번째 장은 200 에서 찍고 800 부터 쓴다
    expect(steps[1]).toEqual({ index: 1, scrollY: 200, sourceTop: 800, height: 200, destTop: 1000 })
  })

  it('장끼리 겹치거나 빈 줄이 생기지 않는다', () => {
    const steps = fullPageSteps({ totalHeight: 5321, viewportHeight: 917, headerHeight: 64 })
    let expected = 0
    for (const step of steps) {
      expect(step.destTop).toBe(expected)
      expect(step.height).toBeGreaterThan(0)
      // 찍은 화면 밖을 참조하지 않는다
      expect(step.sourceTop + step.height).toBeLessThanOrEqual(917)
      expected += step.height
    }
    expect(expected).toBe(5321)
  })

  it('아주 긴 페이지는 최대 높이에서 자른다', () => {
    const steps = fullPageSteps({ totalHeight: 90000, viewportHeight: 1000, headerHeight: 0 })
    expect(fullPageHeight(steps)).toBe(MAX_FULL_PAGE_HEIGHT)
  })

  it('헤더가 화면만큼 크면 무한 루프 대신 멈춘다', () => {
    const steps = fullPageSteps({ totalHeight: 4000, viewportHeight: 500, headerHeight: 500 })
    expect(steps).toHaveLength(1)
  })

  it('크기를 못 읽었으면 빈 목록을 돌려준다', () => {
    expect(fullPageSteps({ totalHeight: 0, viewportHeight: 0, headerHeight: 0 })).toEqual([])
  })
})

describe('파일명 규칙', () => {
  it('YYYYMMDD-HHmmss 형식이다', () => {
    expect(captureTimestamp(new Date(2026, 8, 19, 7, 5, 3))).toBe('20260919-070503')
    expect(captureFileName(new Date(2026, 11, 1, 23, 59, 59), 'png')).toBe('20261201-235959.png')
  })

  it('같은 초에 다시 저장하면 순번을 붙인다', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    expect(captureFileName(d, 'png', 1)).toBe('20260102-030405.png')
    expect(captureFileName(d, 'png', 2)).toBe('20260102-030405-2.png')
  })

  it('비디오는 형식 설정과 무관하게 webm 이다', () => {
    expect(captureExtension('videoScreen', 'jpg')).toBe('webm')
    expect(captureExtension('videoDirect', 'png')).toBe('webm')
    expect(captureExtension('fullPage', 'jpg')).toBe('jpg')
    expect(captureExtension('direct', 'png')).toBe('png')
  })
})

describe('단축키 파싱', () => {
  it('Alt+1 을 분해한다', () => {
    expect(parseCaptureShortcut('Alt+1')).toEqual({
      control: false,
      alt: true,
      shift: false,
      meta: false,
      key: '1'
    })
  })

  it('공백·대소문자를 무시하고 한 글자 키는 소문자로 맞춘다', () => {
    expect(parseCaptureShortcut(' ctrl + SHIFT + S ')).toEqual({
      control: true,
      alt: false,
      shift: true,
      meta: false,
      key: 's'
    })
  })

  it('빈 값·수식 키뿐·키 두 개는 받지 않는다', () => {
    expect(parseCaptureShortcut('')).toBeNull()
    expect(parseCaptureShortcut('Alt')).toBeNull()
    expect(parseCaptureShortcut('Alt+1+2')).toBeNull()
    expect(parseCaptureShortcut(null)).toBeNull()
    expect(parseCaptureShortcut(42)).toBeNull()
  })

  it('keyDown 이 아니거나 수식 키가 다르면 맞지 않는다', () => {
    const parts = parseCaptureShortcut('Alt+1')!
    expect(matchesCaptureShortcut(keyDown('1', { alt: true }), parts)).toBe(true)
    expect(matchesCaptureShortcut({ ...keyDown('1', { alt: true }), type: 'keyUp' }, parts)).toBe(
      false
    )
    expect(matchesCaptureShortcut(keyDown('1', { alt: true, shift: true }), parts)).toBe(false)
    expect(matchesCaptureShortcut(keyDown('1'), parts)).toBe(false)
  })

  it('Alt+1~6 이 각 방식에 그대로 대응한다', () => {
    const expected = ['direct', 'region', 'fullPage', 'fullScreen', 'videoDirect', 'videoScreen']
    expected.forEach((mode, i) => {
      expect(
        captureShortcutMode(keyDown(String(i + 1), { alt: true }), DEFAULT_CAPTURE_SHORTCUTS)
      ).toBe(mode)
    })
  })

  it('작업공간 단축키(Ctrl+Alt+1)는 캡처로 먹히지 않는다', () => {
    expect(
      captureShortcutMode(keyDown('1', { alt: true, control: true }), DEFAULT_CAPTURE_SHORTCUTS)
    ).toBeNull()
  })

  it('빈 단축키는 어떤 입력에도 걸리지 않는다', () => {
    const shortcuts = { ...DEFAULT_CAPTURE_SHORTCUTS, direct: '' }
    expect(captureShortcutMode(keyDown('1', { alt: true }), shortcuts)).toBeNull()
  })

  it('손상된 단축키 표는 항목별로 기본값으로 되돌린다', () => {
    const merged = mergeCaptureShortcuts({ direct: 'Ctrl+Shift+D', region: 12, fullPage: 'Alt' })
    expect(merged.direct).toBe('Ctrl+Shift+D')
    expect(merged.region).toBe(DEFAULT_CAPTURE_SHORTCUTS.region)
    expect(merged.fullPage).toBe(DEFAULT_CAPTURE_SHORTCUTS.fullPage)
    expect(Object.keys(merged).sort()).toEqual([...CAPTURE_MODES].sort())
  })
})

describe('요소 경계 메시지 검증(zod)', () => {
  it('올바른 사각형은 정수로 다듬어 통과시킨다', () => {
    expect(parseCaptureElementRect({ x: 10.7, y: 20.2, width: 100.4, height: 50.6 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 51
    })
  })

  it('음수·0 크기·NaN·과대 크기는 거절한다', () => {
    expect(parseCaptureElementRect({ x: -1, y: 0, width: 10, height: 10 })).toBeNull()
    expect(parseCaptureElementRect({ x: 0, y: 0, width: 0, height: 10 })).toBeNull()
    expect(parseCaptureElementRect({ x: 0, y: 0, width: Number.NaN, height: 10 })).toBeNull()
    expect(parseCaptureElementRect({ x: 0, y: 0, width: 999999, height: 10 })).toBeNull()
  })

  it('모양이 다른 값은 거절한다', () => {
    expect(parseCaptureElementRect(null)).toBeNull()
    expect(parseCaptureElementRect('10,10,10,10')).toBeNull()
    expect(parseCaptureElementRect({ x: '0', y: 0, width: 10, height: 10 })).toBeNull()
    expect(parseCaptureElementRect({ x: 0, y: 0 })).toBeNull()
  })
})

describe('사각형 보조 함수', () => {
  it('드래그 방향과 무관하게 같은 사각형이 된다', () => {
    const a = normalizeDragRect({ x: 10, y: 10 }, { x: 60, y: 40 })
    const b = normalizeDragRect({ x: 60, y: 40 }, { x: 10, y: 10 })
    expect(a).toEqual({ x: 10, y: 10, width: 50, height: 30 })
    expect(a).toEqual(b)
  })

  it('바깥 경계를 넘는 부분은 잘라 낸다', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 }
    expect(clampRect({ x: 80, y: 80, width: 50, height: 50 }, bounds)).toEqual({
      x: 80,
      y: 80,
      width: 20,
      height: 20
    })
    expect(clampRect({ x: 200, y: 0, width: 10, height: 10 }, bounds)).toBeNull()
  })
})

describe('캡처 설정', () => {
  it('기본값은 Alt+1~6 과 png 다', () => {
    expect(DEFAULT_SETTINGS.captureFormat).toBe('png')
    expect(DEFAULT_SETTINGS.captureShortcuts).toEqual(DEFAULT_CAPTURE_SHORTCUTS)
    expect(DEFAULT_SETTINGS.captureDir).toBe('')
  })

  it('손상된 config 값도 항상 유효한 캡처 설정이 된다', () => {
    const s = parseSettings({ captureFormat: 'gif', captureMicrophone: 'yes', captureShortcuts: 7 })
    expect(s.captureFormat).toBe('png')
    expect(s.captureMicrophone).toBe(false)
    expect(s.captureShortcuts).toEqual(DEFAULT_CAPTURE_SHORTCUTS)
  })

  it('사용자가 바꾼 단축키는 그대로 남는다', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      captureShortcuts: { ...DEFAULT_CAPTURE_SHORTCUTS, fullPage: 'Ctrl+Shift+P' }
    })
    expect(s.captureShortcuts.fullPage).toBe('Ctrl+Shift+P')
    expect(s.captureShortcuts.direct).toBe('Alt+1')
  })
})
