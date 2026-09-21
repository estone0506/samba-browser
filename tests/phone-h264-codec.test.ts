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
