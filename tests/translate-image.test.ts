// 이미지 번역 — OCR 결과 변환 · Visual 폴백 파싱 · 우클릭 메뉴 구성 · 자동 번역 도메인

import { describe, it, expect, vi } from 'vitest'
import {
  extractImageBoxes,
  ocrLinesToBoxes,
  parseVisualBoxes,
  translateImage
} from '../src/main/translate/image'
import {
  buildContextTemplate,
  CONTEXT_MENU_LABELS,
  type ContextTarget
} from '../src/main/browser/context-menu'
import {
  addAutoDomain,
  normalizeAutoDomain,
  removeAutoDomain,
  shouldAutoTranslate
} from '../src/shared/translate'

const SIZE = { width: 400, height: 200 }
const PNG = Buffer.from('fake-png')

function target(patch: Partial<ContextTarget> = {}): ContextTarget {
  return { mediaType: 'none', srcURL: '', linkURL: '', selectionText: '', ...patch }
}

const noopActions = {
  copy: (): void => undefined,
  copyLink: (): void => undefined,
  translateImage: (): void => undefined,
  translatePage: (): void => undefined,
  restorePage: (): void => undefined
}

describe('OCR 결과 → 글자 상자', () => {
  it('[x,y,w,h] 를 상자 모양으로 옮기고 빈 줄은 버린다', () => {
    const boxes = ocrLinesToBoxes([
      { text: '안녕', box: [10, 20, 30, 12], score: 0.9 },
      { text: '   ', box: [0, 0, 10, 10], score: 0.8 },
      { text: '넓이없음', box: [0, 0, 0, 10], score: 0.8 }
    ])
    expect(boxes).toEqual([{ x: 10, y: 20, width: 30, height: 12, text: '안녕' }])
  })
})

describe('Visual 폴백 응답 파싱', () => {
  it('0~1 비율을 이미지 픽셀로 환산한다', () => {
    const boxes = parseVisualBoxes('[{"t":"こんにちは","x":0.25,"y":0.5,"w":0.5,"h":0.1}]', SIZE)
    expect(boxes).toEqual([{ x: 100, y: 100, width: 200, height: 20, text: 'こんにちは' }])
  })

  it('설명이 섞여도 배열만 잘라 읽고, 글자가 없으면 빈 배열이다', () => {
    expect(parseVisualBoxes('이미지에는 글자가 없습니다: []', SIZE)).toEqual([])
  })

  it('비율 범위를 벗어나거나 형식이 틀리면 null 이다', () => {
    expect(parseVisualBoxes('[{"t":"x","x":1.5,"y":0,"w":0.1,"h":0.1}]', SIZE)).toBeNull()
    expect(parseVisualBoxes('설명만', SIZE)).toBeNull()
    expect(parseVisualBoxes('[]', { width: 0, height: 0 })).toBeNull()
  })
})

describe('상자 추출 — 로컬 OCR 우선, 못 읽으면 Visual 폴백', () => {
  it('로컬 OCR 이 읽으면 Visual 을 부르지 않는다', async () => {
    const visual = vi.fn()
    const boxes = await extractImageBoxes(
      {
        ocr: async () => [{ text: '한국어', box: [0, 0, 50, 20], score: 0.9 }],
        visual
      },
      PNG,
      SIZE
    )
    expect(boxes.map((b) => b.text)).toEqual(['한국어'])
    expect(visual).not.toHaveBeenCalled()
  })

  it('OCR 이 없거나 한 줄도 못 읽으면 Visual 로 넘어간다', async () => {
    const boxes = await extractImageBoxes(
      {
        ocr: async () => null,
        visual: async () => [{ x: 1, y: 2, width: 3, height: 4, text: '中文' }]
      },
      PNG,
      SIZE
    )
    expect(boxes.map((b) => b.text)).toEqual(['中文'])
  })

  it('OCR 이 예외를 던져도 폴백으로 이어진다', async () => {
    const boxes = await extractImageBoxes(
      {
        ocr: async () => {
          throw new Error('모델 없음')
        },
        visual: async () => [{ x: 0, y: 0, width: 10, height: 10, text: '日本語' }]
      },
      PNG,
      SIZE
    )
    expect(boxes).toHaveLength(1)
  })

  it('둘 다 실패하면 빈 배열이다(오버레이를 띄우지 않는다)', async () => {
    const boxes = await extractImageBoxes(
      { ocr: async () => [], visual: async () => null },
      PNG,
      SIZE
    )
    expect(boxes).toEqual([])
  })
})

describe('이미지 번역', () => {
  it('상자 좌표는 그대로 두고 글자만 번역문으로 바꾼다', async () => {
    const boxes = await translateImage(
      {
        ocr: async () => [
          { text: 'Sale', box: [5, 6, 40, 12], score: 0.9 },
          { text: 'Today only', box: [5, 30, 80, 12], score: 0.9 }
        ],
        visual: async () => null,
        translate: async (texts) => texts.map((t) => `${t}(ko)`)
      },
      PNG,
      SIZE,
      'ko'
    )
    expect(boxes).toEqual([
      { x: 5, y: 6, width: 40, height: 12, text: 'Sale(ko)' },
      { x: 5, y: 30, width: 80, height: 12, text: 'Today only(ko)' }
    ])
  })

  it('글자를 못 읽으면 번역을 부르지 않는다', async () => {
    const translate = vi.fn()
    const boxes = await translateImage(
      { ocr: async () => [], visual: async () => [], translate },
      PNG,
      SIZE,
      'ko'
    )
    expect(boxes).toEqual([])
    expect(translate).not.toHaveBeenCalled()
  })
})

describe('우클릭 메뉴 구성', () => {
  it('이미지 위에서만 "이미지 번역" 이 나온다', () => {
    const labels = CONTEXT_MENU_LABELS.ko
    const onImage = buildContextTemplate(
      target({ mediaType: 'image', srcURL: 'https://a.test/i.png' }),
      labels,
      noopActions
    )
    expect(onImage.map((i) => i.id)).toContain('translateImage')
    const onText = buildContextTemplate(target({ selectionText: '고른 글' }), labels, noopActions)
    expect(onText.map((i) => i.id)).not.toContain('translateImage')
    expect(onText.map((i) => i.id)).toContain('copy')
  })

  it('페이지 번역·원문 보기는 언제나 들어간다', () => {
    const ids = buildContextTemplate(target(), CONTEXT_MENU_LABELS.en, noopActions).map((i) => i.id)
    expect(ids).toEqual(['translatePage', 'restorePage'])
  })

  it('클릭하면 해당 동작이 불린다', () => {
    const translateImage = vi.fn()
    const items = buildContextTemplate(
      target({ mediaType: 'image', srcURL: 'https://a.test/i.png' }),
      CONTEXT_MENU_LABELS.ko,
      { ...noopActions, translateImage }
    )
    const item = items.find((i) => i.id === 'translateImage')
    item?.click?.(undefined as never, undefined as never, undefined as never)
    expect(translateImage).toHaveBeenCalledWith('https://a.test/i.png')
  })
})

describe('자동 번역 도메인', () => {
  it('주소를 붙여 넣어도 도메인만 남긴다', () => {
    expect(normalizeAutoDomain('HTTPS://WWW.Example.com/path?q=1')).toBe('example.com')
    expect(normalizeAutoDomain('example.com:8443')).toBe('example.com')
    expect(normalizeAutoDomain('  ')).toBe('')
  })

  it('하위 도메인도 목록에 걸린다', () => {
    expect(shouldAutoTranslate('news.example.com', ['example.com'])).toBe(true)
    expect(shouldAutoTranslate('www.example.com', ['example.com'])).toBe(true)
    expect(shouldAutoTranslate('notexample.com', ['example.com'])).toBe(false)
  })

  it('추가·삭제는 중복 없이 동작한다', () => {
    let list = addAutoDomain([], 'https://www.Example.com/')
    list = addAutoDomain(list, 'example.com')
    expect(list).toEqual(['example.com'])
    expect(removeAutoDomain(list, 'EXAMPLE.com')).toEqual([])
  })
})
