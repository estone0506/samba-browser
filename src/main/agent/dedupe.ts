export interface TextDeduper {
  // 처음 보는 문단이면 다듬은 문자열을, 이미 내보낸 문단이면 null 을 돌려준다
  accept: (raw: string) => string | null
  // 지금까지 통과시킨 문단 수
  count: () => number
}

// 작업 1건 동안 같은 문단을 두 번 표시하지 않기 위한 중복 제거기.
// SDK 는 스트리밍 중 블록 단위로 assistant 메시지를 보내고 같은 블록이 다시 실릴 수 있어
// 텍스트 자체를 기준으로 건너뛴다(공백 차이는 같은 문단으로 본다).
export function createTextDeduper(): TextDeduper {
  const seen = new Set<string>()
  let passed = 0
  return {
    accept(raw) {
      const text = raw.trim()
      if (!text) return null
      const key = text.replace(/\s+/g, ' ')
      if (seen.has(key)) return null
      seen.add(key)
      passed += 1
      return text
    },
    count() {
      return passed
    }
  }
}
