// H.264 Annex-B 파싱(순수). 렌더러 WebCodecs 가 디코드할 수 있게
// 청크 경계에서 잘린 NAL 을 이어 붙이고 키프레임 도착을 알린다.
// 여기에는 프로세스 실행도 electron 의존도 없다 — 폰 없이 그대로 테스트한다

const START_CODE_3 = Buffer.from([0, 0, 1])
const START_CODE_4 = Buffer.from([0, 0, 0, 1])

/** SPS(시퀀스 파라미터) NAL 타입 */
export const NAL_SPS = 7
/** PPS(픽처 파라미터) NAL 타입 */
export const NAL_PPS = 8
/** IDR(키프레임 조각) NAL 타입 */
export const NAL_IDR = 5

/** NAL 첫 바이트 하위 5비트가 타입이다. 빈 버퍼는 0 */
export function nalType(nal: Buffer): number {
  return nal.length > 0 ? nal[0] & 0x1f : 0
}

/**
 * 시작 코드로 잘라 NAL 페이로드 배열을 돌려준다(시작 코드는 제거).
 * 3바이트(`00 00 01`)·4바이트(`00 00 00 01`) 시작 코드를 모두 인식한다
 */
export function splitAnnexB(buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  const first = buffer.indexOf(START_CODE_3)
  if (first < 0) return out
  let start = first + 3
  while (start < buffer.length) {
    const next = buffer.indexOf(START_CODE_3, start)
    if (next < 0) {
      out.push(buffer.subarray(start))
      break
    }
    // 4바이트 시작 코드면 앞의 0 하나는 시작 코드 몫이라 잘라낸다
    const end = next > start && buffer[next - 1] === 0 ? next - 1 : next
    out.push(buffer.subarray(start, end))
    start = next + 3
  }
  return out.filter((n) => n.length > 0)
}

/** SPS 나 IDR 이 들어 있으면 이 묶음부터 디코드를 시작할 수 있다 */
export function hasKeyframe(nals: Buffer[]): boolean {
  return nals.some((n) => {
    const t = nalType(n)
    return t === NAL_IDR || t === NAL_SPS
  })
}

/** NAL 배열을 4바이트 시작 코드로 다시 이어 붙인다(렌더러로 보낼 바이트) */
export function toAnnexB(nals: Buffer[]): Buffer {
  if (nals.length === 0) return Buffer.alloc(0)
  const parts: Buffer[] = []
  for (const n of nals) {
    parts.push(START_CODE_4, n)
  }
  return Buffer.concat(parts)
}

/**
 * 스트림 청크를 모아 온전한 NAL 만 내보낸다.
 * 마지막(아직 끝을 모르는) NAL 은 다음 push 까지 꼬리로 보관한다
 */
export class AnnexBAssembler {
  private tail: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    const buf: Buffer = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk
    const last = buf.lastIndexOf(START_CODE_3)
    if (last < 0) {
      this.tail = buf
      return []
    }
    // 마지막 시작 코드가 4바이트라면 앞의 0 까지 꼬리로 넘겨야 온전한 시작 코드가 된다
    const cut = last > 0 && buf[last - 1] === 0 ? last - 1 : last
    this.tail = buf.subarray(cut)
    return cut === 0 ? [] : splitAnnexB(buf.subarray(0, cut))
  }

  /** 세그먼트를 다시 열 때 이전 꼬리를 버린다 */
  reset(): void {
    this.tail = Buffer.alloc(0)
  }
}
