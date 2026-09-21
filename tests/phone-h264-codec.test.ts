// 폰 화면 디코더 코덱 — 고정값이 아니라 스트림의 SPS 에서 읽는다

import { describe, it, expect, vi } from 'vitest'

vi.mock('@renderer/stores/phoneStore', () => ({ usePhoneStore: () => () => {} }))

const { codecFromAnnexB } = await import('../src/renderer/src/components/phone/useH264Player')

describe('codecFromAnnexB', () => {
  it('4바이트 시작 코드 뒤의 SPS 에서 프로파일·제약·레벨을 읽는다', () => {
    // 00 00 00 01 | 67(NAL 7) 64 00 28 → High 4.0
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9])
    expect(codecFromAnnexB(data)).toBe('avc1.640028')
  })

  it('3바이트 시작 코드도, 다른 NAL 뒤에 오는 SPS 도 찾는다', () => {
    // AUD(NAL 9) 다음에 SPS: baseline 3.1
    const data = new Uint8Array([0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x27, 0x42, 0xe0, 0x1f, 0x8d])
    expect(codecFromAnnexB(data)).toBe('avc1.42E01F')
  })

  it('SPS 가 없으면 null(기본 코덱으로 연다)', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5]))).toBeNull()
    expect(codecFromAnnexB(new Uint8Array([]))).toBeNull()
  })
})

describe('nextDecodable — 설정 조각과 IDR 이 따로 올 때', () => {
  const SPS = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac]
  const PPS = [0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80]
  const IDR = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]
  const P = [0, 0, 0, 1, 0x41, 0x9a, 0x24, 0x6c]
  const u8 = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat())

  it('SPS/PPS 만 든 조각은 디코더에 넣지 않고 모아 둔다(실기: 31바이트 조각이 디코더를 죽였다)', async () => {
    const { nextDecodable } = await import('../src/renderer/src/components/phone/useH264Player')
    const r = nextDecodable(null, u8(SPS, PPS), false)
    expect(r.chunk).toBeNull()
    expect(r.pending).toEqual(u8(SPS, PPS))
  })

  it('다음 IDR 앞에 모아 둔 설정을 붙여 key 로 넘긴다', async () => {
    const { nextDecodable } = await import('../src/renderer/src/components/phone/useH264Player')
    const r = nextDecodable(u8(SPS, PPS), u8(IDR), false)
    expect(r.pending).toBeNull()
    expect(r.chunk).toEqual({ type: 'key', data: u8(SPS, PPS, IDR) })
  })

  it('첫 IDR 전의 P 프레임은 버리고, 시작된 뒤에는 delta 로 넘긴다', async () => {
    const { nextDecodable } = await import('../src/renderer/src/components/phone/useH264Player')
    expect(nextDecodable(null, u8(P), false).chunk).toBeNull()
    expect(nextDecodable(null, u8(P), true).chunk).toEqual({ type: 'delta', data: u8(P) })
  })

  it('설정과 IDR 이 한 조각에 같이 오면 그대로 key', async () => {
    const { nextDecodable } = await import('../src/renderer/src/components/phone/useH264Player')
    expect(nextDecodable(null, u8(SPS, PPS, IDR), false).chunk?.type).toBe('key')
  })
})
