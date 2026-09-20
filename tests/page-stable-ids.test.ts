// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot, performClick, resetElementIds } from '../src/preload/page-core'
import { encodeFrameId, decodeFrameId, FRAME_ID_STRIDE } from '../src/main/browser/frame-id'
import { serializeSnapshot, STABLE_ID_NOTE } from '../src/shared/snapshot'

/** 라벨 → id 표(스냅샷 하나에서) */
function idsByText(elements: { id: number; text: string; name?: string }[]): Map<string, number> {
  return new Map(elements.map((e) => [e.text || e.name || '', e.id]))
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetElementIds()
})

describe('스냅샷 사이의 안정 id', () => {
  it('두 번 찍어도 같은 요소는 같은 번호다', () => {
    document.body.innerHTML = '<button>85</button><button>90</button>'
    const first = idsByText(buildSnapshot().elements)
    const second = idsByText(buildSnapshot().elements)
    expect(second.get('85')).toBe(first.get('85'))
    expect(second.get('90')).toBe(first.get('90'))
  })

  it('앞쪽에 요소가 끼어들어도 기존 번호는 밀리지 않고 새 요소만 새 번호를 받는다', () => {
    document.body.innerHTML = '<div id="box"><button>85</button><button>90</button></div>'
    const before = idsByText(buildSnapshot().elements)

    // 드롭다운이 열려 앞쪽에 항목이 끼어든 상황
    const opened = document.createElement('button')
    opened.textContent = '드롭다운'
    document.getElementById('box')!.prepend(opened)

    const after = buildSnapshot()
    const ids = idsByText(after.elements)
    expect(ids.get('85')).toBe(before.get('85'))
    expect(ids.get('90')).toBe(before.get('90'))
    // 새 요소는 지금까지 쓴 적 없는 번호
    expect(ids.get('드롭다운')).toBeGreaterThan(before.get('90')!)
    // 나열 순서는 문서 순서 그대로(번호만 안정적이다)
    expect(after.elements.map((e) => e.text)).toEqual(['드롭다운', '85', '90'])
  })

  it('요소가 사라지면 그 번호는 gone 으로 알려 준다', async () => {
    document.body.innerHTML = '<button id="a">85</button><button>90</button>'
    const ids = idsByText(buildSnapshot().elements)
    const goneId = ids.get('85')!
    document.getElementById('a')!.remove()
    buildSnapshot()
    expect(await performClick(goneId)).toBe(`element ${goneId} is gone (call get_page again)`)
  })

  it('한 번도 쓴 적 없는 번호는 여전히 not found 다', async () => {
    document.body.innerHTML = '<button>85</button>'
    buildSnapshot()
    expect(await performClick(9999)).toBe('element 9999 not found (call get_page again)')
  })

  it('사라졌던 번호를 다른 요소가 물려받지 않는다', () => {
    document.body.innerHTML = '<button id="a">85</button><button>90</button>'
    const before = idsByText(buildSnapshot().elements)
    document.getElementById('a')!.remove()
    const fresh = document.createElement('button')
    fresh.textContent = '95'
    document.body.append(fresh)
    const after = idsByText(buildSnapshot().elements)
    expect(after.get('90')).toBe(before.get('90'))
    expect(after.get('95')).not.toBe(before.get('85'))
  })

  it('화면이 통째로 갈리면(남은 요소 0개) 번호를 처음부터 다시 쓴다', () => {
    document.body.innerHTML = '<button>85</button><button>90</button>'
    buildSnapshot()
    document.body.innerHTML = '<button>장바구니</button>'
    const s = buildSnapshot()
    expect(s.elements[0].id).toBe(1)
  })

  it('머리말에 id 가 안정적이라는 한 줄이 있다', () => {
    document.body.innerHTML = '<button>85</button>'
    expect(serializeSnapshot(buildSnapshot())).toContain(STABLE_ID_NOTE)
    expect(STABLE_ID_NOTE).toContain('ids are stable across snapshots on this page')
  })
})

describe('프레임 id 오프셋', () => {
  it('안정 id 에도 k*100000+n 규칙이 그대로 통한다', () => {
    document.body.innerHTML = '<div id="box"><button>주소 검색</button></div>'
    const local = buildSnapshot().elements[0].id
    const encoded = encodeFrameId(2, local)
    expect(encoded).toBe(2 * FRAME_ID_STRIDE + local)
    expect(decodeFrameId(encoded)).toEqual({ frameIndex: 2, id: local })

    // 요소가 끼어들어 지역 id 가 커져도 왕복이 유지된다
    const extra = document.createElement('button')
    extra.textContent = '우편번호'
    document.getElementById('box')!.prepend(extra)
    for (const el of buildSnapshot().elements) {
      expect(decodeFrameId(encodeFrameId(3, el.id))).toEqual({ frameIndex: 3, id: el.id })
    }
  })
})
