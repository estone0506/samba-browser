// 뒤에서 도는 자동화 탭(보이는 탭 아래 층에 붙은 뷰) 정리 규칙 — Electron 없이 시험하려고 떼어 둔 순수 함수.
//
// 창에 붙지 않은 WebContentsView 는 뷰포트가 0 이라(innerHeight 0, getBoundingClientRect 판정 전부 false)
// 스냅샷이 페이지 끝 구매 버튼을 잘라 먹고 레이아웃·렌더링도 어긋났다(c7d1e5a 회귀).
// 그래서 사람이 쓰는 창에서 자동화가 뒤에서 작업할 탭도 창의 contentView 에 붙이되, 보이는 탭보다 아래에 둔다.

/** 뒤 층에 계속 붙여 둘 탭과 떼어 낼 탭을 가른다 */
export function splitBehind(input: {
  /** 지금 뒤 층에 붙어 있는 탭 id(붙인 순서) */
  behind: readonly string[]
  /** 보이는 탭 id — 뒤 층에 둘 수 없다 */
  activeId: string | null
  /** 전역 자동화 대상 탭 id */
  automationId: string | null
  /** 레인이 쥔 탭 id — 레인이 끝나 닫을 때까지 뒤에서 계속 조작한다 */
  laneIds: ReadonlySet<string>
  /** 살아 있는 탭 id */
  alive: ReadonlySet<string>
}): { keep: string[]; drop: string[] } {
  const keep: string[] = []
  const drop: string[] = []
  const seen = new Set<string>()
  for (const id of input.behind) {
    if (seen.has(id)) continue
    seen.add(id)
    const wanted =
      input.alive.has(id) &&
      id !== input.activeId &&
      (id === input.automationId || input.laneIds.has(id))
    ;(wanted ? keep : drop).push(id)
  }
  return { keep, drop }
}

/**
 * contentView 에 올릴 탭 뷰 순서(아래 → 위). 뒤 탭은 모두 보이는 탭 아래, 보이는 탭이 맨 위다.
 * 보이는 탭이 뒤 목록에 섞여 있어도 한 번만, 맨 위에 둔다
 */
export function stackOrder(activeId: string | null, behind: readonly string[]): string[] {
  const order = behind.filter((id, i) => id !== activeId && behind.indexOf(id) === i)
  if (activeId !== null) order.push(activeId)
  return order
}
