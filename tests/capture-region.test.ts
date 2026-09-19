// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { isRegionTarget, toCaptureRect } from '../src/preload/page-capture'
import { parseCaptureElementRect } from '../src/shared/capture'
import { IPC } from '../src/shared/ipc'
import { PAGE_IPC } from '../src/preload/page-constants'

const VIEWPORT = { width: 1200, height: 800 }

describe('요소 경계 → 캡처 사각형', () => {
  it('소수점을 정수로 넓혀 잡는다', () => {
    expect(toCaptureRect({ left: 10.4, top: 20.6, width: 100.2, height: 50.1 }, VIEWPORT)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51
    })
  })

  it('화면 밖으로 나간 부분은 뷰포트 안으로 잘라 넣는다', () => {
    expect(toCaptureRect({ left: -50, top: -20, width: 400, height: 200 }, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
      width: 350,
      height: 180
    })
    expect(toCaptureRect({ left: 1100, top: 700, width: 400, height: 400 }, VIEWPORT)).toEqual({
      x: 1100,
      y: 700,
      width: 100,
      height: 100
    })
  })

  it('보이지 않을 만큼 작거나 화면 밖인 요소는 고르지 않는다', () => {
    expect(toCaptureRect({ left: 10, top: 10, width: 1, height: 100 }, VIEWPORT)).toBeNull()
    expect(toCaptureRect({ left: 5000, top: 10, width: 100, height: 100 }, VIEWPORT)).toBeNull()
  })

  it('만들어진 사각형은 메인의 zod 검증을 그대로 통과한다', () => {
    const rect = toCaptureRect({ left: 10.4, top: 20.6, width: 100.2, height: 50.1 }, VIEWPORT)
    expect(parseCaptureElementRect(rect)).toEqual(rect)
  })
})

describe('하이라이트 대상 판정', () => {
  it('html·body 는 고르지 않는다', () => {
    expect(isRegionTarget(document.documentElement)).toBe(false)
    expect(isRegionTarget(document.body)).toBe(false)
  })

  it('일반 요소는 고른다', () => {
    const div = document.createElement('div')
    expect(isRegionTarget(div)).toBe(true)
    expect(isRegionTarget(null)).toBe(false)
  })
})

describe('page-constants 캡처 채널 동기화', () => {
  it('shared/ipc 와 이름이 같다', () => {
    expect(PAGE_IPC.captureRegionMode).toBe(IPC.captureRegionMode)
    expect(PAGE_IPC.captureElementRect).toBe(IPC.captureElementRect)
  })
})
