// 작업당 도구 호출 상한 카운터
export function makeCounter(max: number): { tick: () => string | null; count: () => number } {
  let n = 0
  return {
    tick: () => {
      n += 1
      return n > max ? `tool call limit (${max}) reached. Call done with what you have.` : null
    },
    count: () => n
  }
}
