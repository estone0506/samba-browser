// 요소 id 안에 프레임 번호를 담는 규칙과 프레임별 스냅샷 합치기(순수 함수).
//
// 주소 검색(29CM 주문서의 카카오 우편번호, 무신사 배송지 추가)·결제 보안 키패드는
// 최상위 문서가 아니라 iframe 안에 있다. 프레임마다 preload 가 따로 id(1,2,3…)를 매기므로
// 메인 프로세스에서 합칠 때 프레임 번호를 얹어 어느 프레임의 몇 번인지 구분한다.
//
// 메인 프레임(0번)은 id 를 그대로 둔다 — 기존 동작과 기존 대화 기록이 그대로 통한다.
// 프레임 k 의 지역 id n 은 k*100000 + n 이다(예: 2번 프레임의 15번 → 200015).

import type { PageElement, PageSnapshot } from '../../shared/snapshot'

/** 프레임 한 칸이 차지하는 id 구간 */
export const FRAME_ID_STRIDE = 100000

/** 한 페이지에서 AI 가 들여다볼 하위 프레임 개수 상한 */
export const MAX_AGENT_FRAMES = 10

/** 프레임 하나에서 가져올 요소 개수 상한 */
export const MAX_FRAME_ELEMENTS = 300

/** 프레임 번호 + 지역 id → 바깥에 내보내는 id */
export function encodeFrameId(frameIndex: number, id: number): number {
  if (frameIndex <= 0) return id
  // 지역 id 가 구간을 넘으면 다른 프레임의 id 와 겹친다. 그런 페이지는 없지만
  // 겹치느니 메인 프레임 id 로 두는 편이 낫다(클릭 대상이 엉뚱해지지 않는다)
  if (id < 1 || id >= FRAME_ID_STRIDE) return id
  return frameIndex * FRAME_ID_STRIDE + id
}

/** 바깥 id → 프레임 번호 + 그 프레임 안에서의 지역 id */
export function decodeFrameId(encoded: number): { frameIndex: number; id: number } {
  if (!Number.isFinite(encoded) || encoded < FRAME_ID_STRIDE) return { frameIndex: 0, id: encoded }
  const frameIndex = Math.floor(encoded / FRAME_ID_STRIDE)
  return { frameIndex, id: encoded - frameIndex * FRAME_ID_STRIDE }
}

/** 프레임 하나에서 읽어 온 스냅샷 */
export interface FrameSnapshot {
  /** 1 부터. 0 은 메인 프레임이라 이 목록에 오지 않는다 */
  index: number
  host: string
  snapshot: PageSnapshot
}

// 프레임 본문 텍스트는 앞부분만 가져온다 — 메인 프레임 텍스트를 밀어내지 않도록
const FRAME_TEXT_MAX = 2000

/** 프레임 요소에 번호를 얹는다(id 재계산 + 구분 헤더용 frame 정보) */
function tagElements(frame: FrameSnapshot): PageElement[] {
  return frame.snapshot.elements.slice(0, MAX_FRAME_ELEMENTS).map((e) => ({
    ...e,
    id: encodeFrameId(frame.index, e.id),
    frame: { index: frame.index, host: frame.host }
  }))
}

/**
 * 메인 프레임 스냅샷에 iframe 스냅샷을 합친다.
 * 메인 프레임 요소는 id 도 순서도 그대로다 — 프레임 요소는 언제나 뒤에 붙는다
 */
export function mergeFrameSnapshots(
  main: PageSnapshot,
  frames: readonly FrameSnapshot[]
): PageSnapshot {
  const picked = frames.slice(0, MAX_AGENT_FRAMES)
  if (picked.length === 0) return main
  const elements = picked.reduce<PageElement[]>(
    (acc, frame) => acc.concat(tagElements(frame)),
    main.elements.slice()
  )
  const total = picked.reduce(
    (sum, frame) =>
      sum + Math.min(frame.snapshot.total ?? frame.snapshot.elements.length, MAX_FRAME_ELEMENTS),
    main.total ?? main.elements.length
  )
  const texts = picked
    .filter((frame) => frame.snapshot.text.length > 0)
    .map(
      (frame) =>
        `[frame ${frame.index}: ${frame.host}] ${frame.snapshot.text.slice(0, FRAME_TEXT_MAX)}`
    )
  return {
    ...main,
    elements,
    total,
    text: [main.text, ...texts].filter((t) => t.length > 0).join('\n')
  }
}
