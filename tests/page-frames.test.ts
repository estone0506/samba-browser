import { describe, it, expect } from 'vitest'
import type { PageElement, PageSnapshot } from '../src/shared/snapshot'
import { serializeSnapshot, listedElements, MAX_ELEMENTS } from '../src/shared/snapshot'
import {
  encodeFrameId,
  decodeFrameId,
  mergeFrameSnapshots,
  FRAME_ID_STRIDE,
  MAX_AGENT_FRAMES,
  MAX_FRAME_ELEMENTS,
  type FrameSnapshot
} from '../src/main/browser/frame-id'
import { isAgentFrameUrl, frameHost } from '../src/main/browser/page-bridge'

function el(id: number, text = ''): PageElement {
  return { id, tag: 'button', role: 'button', text, isSecret: false }
}

function snap(elements: PageElement[], over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://order.29cm.co.kr/order',
    title: '주문서',
    text: '주문서',
    elements,
    total: elements.length,
    ...over
  }
}

function frame(index: number, host: string, elements: PageElement[], text = ''): FrameSnapshot {
  return {
    index,
    host,
    snapshot: {
      url: `https://${host}/`,
      title: '',
      text,
      elements,
      total: elements.length
    }
  }
}

describe('프레임 id 인코딩/디코딩', () => {
  it('메인 프레임(0번) id 는 그대로다', () => {
    expect(encodeFrameId(0, 15)).toBe(15)
    expect(decodeFrameId(15)).toEqual({ frameIndex: 0, id: 15 })
  })

  it('프레임 k 의 id 는 k*100000 을 얹는다', () => {
    expect(encodeFrameId(2, 15)).toBe(200015)
    expect(encodeFrameId(1, 1)).toBe(100001)
  })

  it('인코딩과 디코딩은 서로를 되돌린다', () => {
    for (const frameIndex of [0, 1, 2, 5, MAX_AGENT_FRAMES]) {
      for (const id of [1, 7, 150, 4321, FRAME_ID_STRIDE - 1]) {
        expect(decodeFrameId(encodeFrameId(frameIndex, id))).toEqual({ frameIndex, id })
      }
    }
  })

  it('구간을 넘는 지역 id 는 얹지 않는다(다른 프레임과 겹치지 않게)', () => {
    expect(encodeFrameId(2, FRAME_ID_STRIDE)).toBe(FRAME_ID_STRIDE)
    expect(encodeFrameId(2, 0)).toBe(0)
  })

  it('이상한 값은 메인 프레임으로 본다', () => {
    expect(decodeFrameId(0)).toEqual({ frameIndex: 0, id: 0 })
    expect(decodeFrameId(Number.NaN).frameIndex).toBe(0)
  })
})

describe('스냅샷 합치기', () => {
  it('프레임이 없으면 원본 그대로다', () => {
    const main = snap([el(1), el(2)])
    expect(mergeFrameSnapshots(main, [])).toBe(main)
  })

  it('iframe 요소는 뒤에 붙고 id 에 프레임 번호가 얹힌다', () => {
    const merged = mergeFrameSnapshots(snap([el(1, '주문하기')]), [
      frame(1, 'postcode.map.daum.net', [el(3, '검색'), el(4, '서울')], '우편번호 검색')
    ])
    expect(merged.elements.map((e) => e.id)).toEqual([1, 100003, 100004])
    // 메인 프레임 요소는 표식이 없고, 프레임 요소에는 번호·호스트가 붙는다
    expect(merged.elements[0].frame).toBeUndefined()
    expect(merged.elements[1].frame).toEqual({ index: 1, host: 'postcode.map.daum.net' })
  })

  it('프레임 본문 텍스트를 구분 머리말과 함께 잇는다', () => {
    const merged = mergeFrameSnapshots(snap([el(1)], { text: '주문서' }), [
      frame(2, 'postcode.map.daum.net', [el(1)], '우편번호 검색')
    ])
    expect(merged.text).toBe('주문서\n[frame 2: postcode.map.daum.net] 우편번호 검색')
  })

  it('전체 개수는 프레임 몫까지 더한다', () => {
    const merged = mergeFrameSnapshots(snap([el(1)], { total: 900 }), [
      frame(1, 'a.example', [el(1)], '')
    ])
    expect(merged.total).toBe(901)
  })

  it('프레임은 10개까지, 프레임당 요소는 300개까지만 쓴다', () => {
    const many = Array.from({ length: 400 }, (_, i) => el(i + 1))
    const frames = Array.from({ length: 14 }, (_, i) => frame(i + 1, `f${i}.example`, many))
    const merged = mergeFrameSnapshots(snap([el(1)]), frames)
    expect(merged.elements.length).toBe(1 + MAX_AGENT_FRAMES * MAX_FRAME_ELEMENTS)
    // 11번째 이후 프레임은 아예 들어오지 않는다
    expect(merged.elements.some((e) => (e.frame?.index ?? 0) > MAX_AGENT_FRAMES)).toBe(false)
  })
})

describe('직렬화: 프레임 구분 헤더', () => {
  it('프레임이 바뀌는 자리에 [frame N: host] 한 줄이 들어간다', () => {
    const merged = mergeFrameSnapshots(snap([el(1, '주문하기')]), [
      frame(2, 'postcode.map.daum.net', [el(3, '검색')]),
      frame(3, 'image.msscdn.net', [el(1, '닫기')])
    ])
    const lines = serializeSnapshot(merged).split('\n')
    expect(lines).toContain('[frame 2: postcode.map.daum.net]')
    expect(lines).toContain('[frame 3: image.msscdn.net]')
    // 헤더 바로 다음 줄이 그 프레임의 첫 요소다
    const at = lines.indexOf('[frame 2: postcode.map.daum.net]')
    expect(lines[at + 1]).toContain('[200003]')
  })

  it('메인 프레임이 상한을 다 써도 iframe 요소는 나열에서 빠지지 않는다', () => {
    const main = Array.from({ length: MAX_ELEMENTS + 50 }, (_, i) => el(i + 1))
    const merged = mergeFrameSnapshots(snap(main), [
      frame(1, 'postcode.map.daum.net', [el(1, '우편번호 검색')])
    ])
    const listed = listedElements(merged)
    expect(listed.length).toBe(MAX_ELEMENTS + 1)
    expect(listed.at(-1)?.id).toBe(100001)
    expect(serializeSnapshot(merged)).toContain('[frame 1: postcode.map.daum.net]')
  })
})

describe('프레임 걸러내기', () => {
  it('about:blank·빈 주소·확장 프로그램 프레임은 다루지 않는다', () => {
    expect(isAgentFrameUrl('')).toBe(false)
    expect(isAgentFrameUrl('about:blank')).toBe(false)
    expect(isAgentFrameUrl('chrome-extension://abc/popup.html')).toBe(false)
    expect(isAgentFrameUrl('data:text/html,<p>x')).toBe(false)
  })

  it('http(s) 프레임만 다룬다', () => {
    expect(isAgentFrameUrl('https://postcode.map.daum.net/guide')).toBe(true)
    expect(isAgentFrameUrl('http://order.29cm.co.kr/zip')).toBe(true)
  })

  it('호스트를 뽑아 구분 헤더에 쓴다', () => {
    expect(frameHost('https://postcode.map.daum.net/guide?x=1')).toBe('postcode.map.daum.net')
    expect(frameHost('not a url')).toBe('')
  })
})
