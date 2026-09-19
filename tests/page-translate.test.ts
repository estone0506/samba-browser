// @vitest-environment jsdom
// 화면 번역 — 텍스트 노드 수집·원문 복원·배치 분할·이미지 오버레이 좌표 환산

import { describe, it, expect } from 'vitest'
import {
  collectTextNodes,
  installPageTranslate,
  isEditableElement,
  isTranslatableTextNode,
  mapImageBox,
  ORIG_ATTR,
  overlayFontSize,
  restoreOriginals,
  runWithLimit,
  sortByViewportOrder,
  splitBatches,
  wrapTextNodes,
  type TranslateProgress
} from '../src/preload/page-translate'
import {
  TRANSLATE_CONCURRENCY,
  TRANSLATE_MAX_CHARS,
  TRANSLATE_MAX_NODES
} from '../src/preload/page-constants'
import {
  TRANSLATE_CONCURRENCY as SHARED_CONCURRENCY,
  TRANSLATE_MAX_CHARS as SHARED_CHARS,
  TRANSLATE_MAX_NODES as SHARED_NODES
} from '../src/shared/translate'

describe('page-constants 의 번역 상한은 shared 원본과 같다', () => {
  it('노드 수·문자 수 상한이 일치한다', () => {
    expect(TRANSLATE_MAX_NODES).toBe(SHARED_NODES)
    expect(TRANSLATE_MAX_CHARS).toBe(SHARED_CHARS)
  })

  it('동시 실행 수가 일치한다', () => {
    expect(TRANSLATE_CONCURRENCY).toBe(SHARED_CONCURRENCY)
  })

  it('첫 배치가 빨리 뜨도록 상한을 작게 유지한다', () => {
    expect(SHARED_NODES).toBeLessThanOrEqual(30)
    expect(SHARED_CHARS).toBeLessThanOrEqual(1200)
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

  it("contenteditable 은 '' · plaintext-only 도 편집 가능으로 본다", () => {
    document.body.innerHTML =
      '<div contenteditable>빈 값</div>' +
      '<div contenteditable="plaintext-only">평문만</div>' +
      '<div contenteditable="false">보통 글</div>'
    expect(collectTextNodes(document.body).map((n) => n.nodeValue)).toEqual(['보통 글'])
  })

  it('isEditableElement 는 브라우저 판정(isContentEditable)을 먼저 믿는다', () => {
    document.body.innerHTML = '<div><span>상속받은 편집 영역</span></div>'
    const span = document.querySelector('span')!
    // 실제 브라우저는 부모의 contenteditable 을 상속해 true 를 돌려준다
    Object.defineProperty(span, 'isContentEditable', { value: true, configurable: true })
    expect(isEditableElement(span)).toBe(true)
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

describe('동시 실행 제한', () => {
  it('동시에 도는 할 일 수가 한도를 넘지 않는다', async () => {
    let now = 0
    let peak = 0
    const order: number[] = []
    const tasks = Array.from({ length: 9 }, (_, i) => async () => {
      now += 1
      peak = Math.max(peak, now)
      await new Promise((r) => setTimeout(r, 5))
      order.push(i)
      now -= 1
    })
    await runWithLimit(tasks, 3)
    expect(peak).toBe(3)
    expect(order).toHaveLength(9)
  })

  it('한 할 일이 실패해도 나머지를 끝까지 돌린다', async () => {
    const done: number[] = []
    const tasks = [
      async () => {
        done.push(0)
      },
      async () => {
        throw new Error('배치 실패')
      },
      async () => {
        done.push(2)
      }
    ]
    await runWithLimit(tasks, 2)
    expect(done).toEqual([0, 2])
  })

  it('할 일이 없으면 곧바로 끝난다', async () => {
    await expect(runWithLimit([], 3)).resolves.toBeUndefined()
  })
})

describe('화면 위→아래 정렬', () => {
  it('위쪽 요소가 먼저 번역되도록 세운다', () => {
    const items = [
      { id: 'c', top: 300, left: 0 },
      { id: 'a', top: 10, left: 0 },
      { id: 'b', top: 120, left: 0 }
    ]
    const sorted = sortByViewportOrder(items, (v) => ({ top: v.top, left: v.left }))
    expect(sorted.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('같은 높이면 왼쪽부터, 그래도 같으면 원래 순서를 지킨다', () => {
    const items = [
      { id: 'right', top: 10, left: 500 },
      { id: 'left', top: 10, left: 20 },
      { id: 'same', top: 10, left: 20 }
    ]
    const sorted = sortByViewportOrder(items, (v) => ({ top: v.top, left: v.left }))
    expect(sorted.map((v) => v.id)).toEqual(['left', 'same', 'right'])
  })
})

describe('번역 실행 · 진행률 보고', () => {
  // jsdom 에는 IntersectionObserver 가 없어 설치 코드가 "한 번에 전부" 경로로 간다
  it('배치를 동시에 띄우고 도착하는 대로 화면에 꽂는다', async () => {
    document.body.innerHTML = Array.from({ length: 70 }, (_, i) => `<p>source ${i} text</p>`).join(
      ''
    )
    let now = 0
    let peak = 0
    const progress: TranslateProgress[] = []
    const api = installPageTranslate({
      translate: async (texts) => {
        now += 1
        peak = Math.max(peak, now)
        await new Promise((r) => setTimeout(r, 3))
        now -= 1
        return { ok: true, texts: texts.map((t) => `[번역]${t}`) }
      },
      progress: (p) => progress.push({ ...p })
    })
    await api.run('ko')
    await new Promise((r) => setTimeout(r, 80))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(TRANSLATE_CONCURRENCY)
    expect(document.body.textContent).toContain('[번역]source 0 text')
    const last = progress[progress.length - 1]
    expect(last.total).toBe(70)
    expect(last.done).toBe(70)
    expect(last.running).toBe(false)
    // 다 끝나기 전에도 중간 진행률이 보고된다("번역 중 12/70")
    expect(progress.some((p) => p.running && p.done > 0 && p.done < p.total)).toBe(true)
    api.restore()
  })

  it('실패하면 사유 코드를 진행률에 실어 보낸다', async () => {
    document.body.innerHTML = '<p>hello</p>'
    const progress: TranslateProgress[] = []
    const api = installPageTranslate({
      translate: async () => ({ ok: false, error: 'translate:needs-ai' }),
      progress: (p) => progress.push({ ...p })
    })
    await api.run('ko')
    await new Promise((r) => setTimeout(r, 20))
    expect(progress.some((p) => p.error === 'translate:needs-ai')).toBe(true)
    expect(document.body.textContent).toContain('hello')
    api.restore()
  })

  it('원문 보기는 진행률을 0 으로 되돌린다', async () => {
    document.body.innerHTML = '<p>hello</p>'
    const progress: TranslateProgress[] = []
    const api = installPageTranslate({
      translate: async (texts) => ({ ok: true, texts: texts.map(() => '안녕') }),
      progress: (p) => progress.push({ ...p })
    })
    await api.run('ko')
    await new Promise((r) => setTimeout(r, 20))
    api.restore()
    const last = progress[progress.length - 1]
    expect(last).toEqual({ running: false, done: 0, total: 0 })
    expect(document.body.textContent).toContain('hello')
  })
})
