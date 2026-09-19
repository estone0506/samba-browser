// H.264 Annex-B 파싱 테스트. 실제 폰도 adb 도 쓰지 않고 손으로 만든 바이트만 다룬다

import { describe, it, expect } from 'vitest'
import {
  splitAnnexB,
  nalType,
  hasKeyframe,
  toAnnexB,
  AnnexBAssembler
} from '../src/main/phone/h264'

/** 4바이트 시작 코드 + 페이로드 */
function nal4(type: number, ...rest: number[]): Buffer {
  return Buffer.from([0, 0, 0, 1, type & 0x1f, ...rest])
}

/** 3바이트 시작 코드 + 페이로드 */
function nal3(type: number, ...rest: number[]): Buffer {
  return Buffer.from([0, 0, 1, type & 0x1f, ...rest])
}

describe('splitAnnexB', () => {
  it('3바이트와 4바이트 시작 코드를 모두 인식한다', () => {
    const buf = Buffer.concat([nal4(7, 0xaa), nal3(8, 0xbb), nal4(5, 0xcc, 0xdd)])
    const nals = splitAnnexB(buf)
    expect(nals.map((n) => nalType(n))).toEqual([7, 8, 5])
    expect(nals[0]).toEqual(Buffer.from([7, 0xaa]))
    expect(nals[2]).toEqual(Buffer.from([5, 0xcc, 0xdd]))
  })

  it('시작 코드가 없으면 빈 배열이다', () => {
    expect(splitAnnexB(Buffer.from([1, 2, 3]))).toEqual([])
  })

  it('앞쪽 쓰레기 바이트는 버린다', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), nal4(1, 0x01)])
    expect(splitAnnexB(buf).map(nalType)).toEqual([1])
  })
})

describe('nalType', () => {
  it('첫 바이트의 하위 5비트를 돌려준다', () => {
    expect(nalType(Buffer.from([0x67]))).toBe(7)
    expect(nalType(Buffer.from([0x65]))).toBe(5)
    expect(nalType(Buffer.from([0x41]))).toBe(1)
  })

  it('빈 버퍼는 0 이다', () => {
    expect(nalType(Buffer.alloc(0))).toBe(0)
  })
})

describe('hasKeyframe', () => {
  it('SPS(7)·PPS(8)·IDR(5) 가 들어 있으면 참이다', () => {
    const nals = splitAnnexB(Buffer.concat([nal4(7, 1), nal4(8, 2), nal4(5, 3)]))
    expect(hasKeyframe(nals)).toBe(true)
  })

  it('비-IDR 조각(1)만 있으면 거짓이다', () => {
    const nals = splitAnnexB(Buffer.concat([nal4(1, 1), nal4(1, 2)]))
    expect(hasKeyframe(nals)).toBe(false)
  })
})

describe('AnnexBAssembler', () => {
  it('청크 경계에서 잘린 NAL 을 두 청크를 합쳐 온전하게 돌려준다', () => {
    const whole = Buffer.concat([nal4(7, 0xaa, 0xbb), nal4(5, 0xcc, 0xdd), nal4(1, 0xee)])
    const a = new AnnexBAssembler()
    const cut = 7 // 두 번째 NAL 한가운데
    const first = a.push(whole.subarray(0, cut))
    const second = a.push(whole.subarray(cut))
    const all = [...first, ...second]
    expect(all.map(nalType)).toEqual([7, 5])
    expect(all[0]).toEqual(Buffer.from([7, 0xaa, 0xbb]))
    expect(all[1]).toEqual(Buffer.from([5, 0xcc, 0xdd]))
  })

  it('마지막 미완성 NAL 은 다음 push 까지 보관한다', () => {
    const a = new AnnexBAssembler()
    expect(a.push(nal4(7, 0xaa))).toEqual([])
    const out = a.push(nal4(5, 0xbb))
    expect(out.map(nalType)).toEqual([7])
    expect(out[0]).toEqual(Buffer.from([7, 0xaa]))
  })

  it('시작 코드가 하나도 없는 청크는 통째로 보관한다', () => {
    const a = new AnnexBAssembler()
    expect(a.push(Buffer.from([0x11, 0x22]))).toEqual([])
    const out = a.push(Buffer.concat([Buffer.from([0x33]), nal4(1, 0x44), nal4(1, 0x55)]))
    expect(out.map(nalType)).toEqual([1])
  })

  it('reset 하면 보관된 꼬리를 버린다', () => {
    const a = new AnnexBAssembler()
    a.push(nal4(7, 0xaa))
    a.reset()
    expect(a.push(nal4(5, 0xbb))).toEqual([])
  })
})

describe('toAnnexB', () => {
  it('NAL 배열을 4바이트 시작 코드로 다시 이어 붙인다(왕복이 같다)', () => {
    const nals = [Buffer.from([7, 0xaa]), Buffer.from([5, 0xbb, 0xcc])]
    const buf = toAnnexB(nals)
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]))
    expect(splitAnnexB(buf)).toEqual(nals)
  })

  it('빈 배열은 빈 버퍼다', () => {
    expect(toAnnexB([]).length).toBe(0)
  })
})
