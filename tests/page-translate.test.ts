// @vitest-environment jsdom
// 화면 번역 — 텍스트 노드 수집·원문 복원·배치 분할·이미지 오버레이 좌표 환산

import { describe, it, expect } from 'vitest'
import {
  collectTextNodes,
  isTranslatableTextNode,
  mapImageBox,
  ORIG_ATTR,
  overlayFontSize,
  restoreOriginals,
  splitBatches,
  wrapTextNodes
} from '../src/preload/page-translate'
import { TRANSLATE_MAX_CHARS, TRANSLATE_MAX_NODES } from '../src/preload/page-constants'
import { TRANSLATE_MAX_CHARS as SHARED_CHARS } from '../src/shared/translate'
import { TRANSLATE_MAX_NODES as SHARED_NODES } from '../src/shared/translate'

describe('page-constants 의 번역 상한은 shared 원본과 같다', () => {
  it('노드 수·문자 수 상한이 일치한다', () => {
    expect(TRANSLATE_MAX_NODES).toBe(SHARED_NODES)
    expect(TRANSLATE_MAX_CHARS).toBe(SHARED_CHARS)
  })
})

describe('텍스트 노드 수집', () => {
  it('script·style·입력칸은 건너뛰고 본문만 모은다', () => {
    document.body.innerHTML = `
      <p>안녕하세요</p>
      <script>var hidden = '스크립트 문자열'</script>
      <style>.a { content: '스타일' }</style>
      <textarea>입력한 값</textarea>
      <input type="password" value="비밀번호">
      <input type="text" value="아이디">
      <div>Hello world</div>
    `
    const texts = collectTextNodes(document.body).map((n) => (n.nodeValue ?? '').trim())
    expect(texts).toContain('안녕하세요')
    expect(texts).toContain('Hello world')
    expect(texts.some((t) => t.includes('스크립트'))).toBe(false)
    expect(texts.some((t) => t.includes('스타일'))).toBe(false)
    expect(texts.some((t) => t.includes('입력한 값'))).toBe(false)
  })

  it('입력칸의 value 는 텍스트 노드가 아니므로 애초에 수집되지 않는다', () => {
    document.body.innerHTML = '<input type="password" value="p@ssw0rd">'
    expect(collectTextNodes(document.body)).toHaveLength(0)
  })

  it('공백·숫자·기호만 있는 노드는 제외한다', () => {
    document.body.innerHTML = '<p> </p><p>· 2024 —</p><p>글자</p>'
    const nodes = collectTextNodes(document.body)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].nodeValue).toBe('글자')
  })

  it('contenteditable 안은 번역하지 않는다(편집 중인 글이 바뀌면 안 된다)', () => {
    document.body.innerHTML = '<div contenteditable="true">작성 중인 글</div>'
    expect(collectTextNodes(document.body)).toHaveLength(0)
  })

  it('translate="no" 로 표시된 영역은 건너뛴다', () => {
    document.body.innerHTML = '<span translate="no">SAMBA Browser</span><span>제품</span>'
    const nodes = collectTextNodes(document.body)
    expect(nodes.map((n) => n.nodeValue)).toEqual(['제품'])
  })

  it('isTranslatableTextNode 는 감싼 노드를 다시 고르지 않는다', () => {
    document.body.innerHTML = '<p>원문</p>'
    const [node] = collectTextNodes(document.body)
    wrapTextNodes([node])
    expect(isTranslatableTextNode(node)).toBe(false)
  })
})

describe('원문 보존과 복원', () => {
  it('감싼 span 에 원문이 남고, 번역 후에도 복원된다', () => {
    document.body.innerHTML = '<p>원래 문장</p><div>Another line</div>'
    const wrapped = wrapTextNodes(collectTextNodes(document.body))
    expect(wrapped).toHaveLength(2)
    expect(wrapped[0].getAttribute(ORIG_ATTR)).toBe('원래 문장')

    // 번역문으로 갈아 끼운다
    wrapped[0].textContent = 'Original sentence'
    wrapped[1].textContent = '다른 줄'
    expect(document.body.textContent).toContain('Original sentence')

    const restored = restoreOriginals(document.body)
    expect(restored).toBe(2)
    expect(document.body.innerHTML).toBe('<p>원래 문장</p><div>Another line</div>')
  })

  it('복원 후에는 표식이 하나도 남지 않는다', () => {
    document.body.innerHTML = '<p>문장 하나</p>'
    wrapTextNodes(collectTextNodes(document.body))
    restoreOriginals(document.body)
    expect(document.body.querySelectorAll(`[${ORIG_ATTR}]`)).toHaveLength(0)
  })
})

describe('배치 분할', () => {
  it('노드 수 상한으로 끊는다', () => {
    const texts = Array.from({ length: 250 }, () => 'a')
    const batches = splitBatches(texts, 100, 10_000)
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50])
    expect(batches[1][0]).toBe(100)
  })

  it('문자 수 상한으로도 끊는다', () => {
    const texts = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]
    const batches = splitBatches(texts, 100, 700)
    expect(batches).toEqual([[0, 1], [2]])
  })

  it('혼자서 상한을 넘는 항목도 버리지 않고 단독 배치로 보낸다', () => {
    const texts = ['짧다', 'x'.repeat(9000), '짧다']
    const batches = splitBatches(texts, 100, 4096)
    expect(batches).toEqual([[0], [1], [2]])
    expect(batches.flat()).toHaveLength(3)
  })

  it('빈 입력은 빈 배열이다', () => {
    expect(splitBatches([])).toEqual([])
  })
})

describe('이미지 오버레이 좌표 환산', () => {
  const natural = { width: 800, height: 400 }

  it('표시 크기가 절반이면 상자도 절반이 된다', () => {
    const mapped = mapImageBox({ x: 100, y: 50, width: 200, height: 40, text: '가' }, natural, {
      left: 10,
      top: 20,
      width: 400,
      height: 200
    })
    expect(mapped).toEqual({ left: 60, top: 45, width: 100, height: 20 })
  })

  it('스크롤 오프셋을 더해 문서 좌표로 만든다', () => {
    const mapped = mapImageBox(
      { x: 0, y: 0, width: 80, height: 40, text: '가' },
      natural,
      { left: 10, top: 20, width: 800, height: 400 },
      { x: 5, y: 300 }
    )
    expect(mapped.left).toBe(15)
    expect(mapped.top).toBe(320)
  })

  it('원본 크기를 모르면 0 크기 상자를 돌려준다', () => {
    const mapped = mapImageBox(
      { x: 1, y: 1, width: 1, height: 1, text: '가' },
      { width: 0, height: 0 },
      { left: 0, top: 0, width: 100, height: 100 }
    )
    expect(mapped).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })

  it('글자 크기는 상자 높이를 따르되 10~28px 안에 묶인다', () => {
    expect(overlayFontSize(4)).toBe(10)
    expect(overlayFontSize(20)).toBe(14)
    expect(overlayFontSize(200)).toBe(28)
  })
})
