import { describe, it, expect } from 'vitest'
import {
  MIN_VIDEO_REGION_SIZE,
  shortenCapturePath,
  videoRegionCrop,
  type VideoRegionSource
} from '../src/shared/capture'

/** 배율에 맞춘 웹뷰 영역(화면 픽셀). CSS 로는 (100, 50) 에 800×600 인 웹뷰다 */
function sourceAt(scaleFactor: number): VideoRegionSource {
  const viewport = {
    x: Math.round(100 * scaleFactor),
    y: Math.round(50 * scaleFactor),
    width: Math.round(800 * scaleFactor),
    height: Math.round(600 * scaleFactor)
  }
  return { viewport, crop: viewport, scaleFactor }
}

describe('녹화 영역 좌표 변환', () => {
  it('배율 1 에서는 웹뷰 원점만큼 옮긴다', () => {
    expect(videoRegionCrop({ x: 10, y: 20, width: 200, height: 100 }, sourceAt(1))).toEqual({
      x: 110,
      y: 70,
      width: 200,
      height: 100
    })
  })

  it('배율 1.5 에서는 오프셋·크기를 함께 키운다', () => {
    expect(videoRegionCrop({ x: 10, y: 20, width: 200, height: 100 }, sourceAt(1.5))).toEqual({
      x: 165,
      y: 105,
      width: 300,
      height: 150
    })
  })

  it('모바일 배율 2.6 에서도 같은 규칙을 쓴다', () => {
    expect(videoRegionCrop({ x: 10, y: 20, width: 200, height: 100 }, sourceAt(2.6))).toEqual({
      x: 286, // 260 + 26
      y: 182, // 130 + 52
      width: 520,
      height: 260
    })
  })

  it('웹뷰 밖으로 나간 부분은 잘라 넣는다', () => {
    expect(videoRegionCrop({ x: 700, y: 500, width: 400, height: 400 }, sourceAt(1))).toEqual({
      x: 800,
      y: 550,
      width: 100,
      height: 100
    })
  })

  it('화면 밖으로 잘린 웹뷰에서는 보이는 부분까지만 녹화한다', () => {
    const scaleFactor = 1
    const viewport = { x: -100, y: 50, width: 800, height: 600 }
    // 화면 왼쪽 밖으로 100px 나가 있어 실제로 녹화할 수 있는 곳은 x >= 0 이다
    const source: VideoRegionSource = {
      viewport,
      crop: { x: 0, y: 50, width: 700, height: 600 },
      scaleFactor
    }
    expect(videoRegionCrop({ x: 50, y: 0, width: 200, height: 200 }, source)).toEqual({
      x: 0,
      y: 50,
      width: 150,
      height: 200
    })
  })

  it('crop 이 없으면 웹뷰 영역을 경계로 쓴다', () => {
    const source = { ...sourceAt(1), crop: null }
    expect(videoRegionCrop({ x: 0, y: 0, width: 900, height: 100 }, source)).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 100
    })
  })

  it('최소 크기보다 작게 끌면 무시한다', () => {
    const tooSmall = MIN_VIDEO_REGION_SIZE - 1
    expect(videoRegionCrop({ x: 0, y: 0, width: tooSmall, height: 200 }, sourceAt(1))).toBeNull()
    expect(videoRegionCrop({ x: 0, y: 0, width: 200, height: tooSmall }, sourceAt(1))).toBeNull()
    expect(
      videoRegionCrop(
        { x: 0, y: 0, width: MIN_VIDEO_REGION_SIZE, height: MIN_VIDEO_REGION_SIZE },
        sourceAt(1)
      )
    ).not.toBeNull()
  })

  it('웹뷰와 겹치지 않는 선택은 없는 것으로 본다', () => {
    expect(videoRegionCrop({ x: 900, y: 700, width: 100, height: 100 }, sourceAt(1))).toBeNull()
  })
})

describe('저장 폴더 경로 줄이기', () => {
  it('짧은 경로는 그대로 둔다', () => {
    expect(shortenCapturePath('D:\\캡처')).toBe('D:\\캡처')
  })

  it('긴 경로는 앞을 접고 뒤쪽 폴더를 남긴다', () => {
    const shortened = shortenCapturePath('C:\\Users\\samba\\Downloads\\SAMBA 캡처', 24)
    expect(shortened.startsWith('…')).toBe(true)
    expect(shortened.endsWith('SAMBA 캡처')).toBe(true)
    expect(shortened.length).toBeLessThanOrEqual(24)
  })

  it('폴더 이름 하나가 상한보다 길면 뒷부분만 남긴다', () => {
    const shortened = shortenCapturePath(`/home/${'a'.repeat(60)}`, 20)
    expect(shortened.length).toBe(20)
    expect(shortened.startsWith('…')).toBe(true)
  })
})
