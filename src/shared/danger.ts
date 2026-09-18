// 실행 전 사용자 확인이 필요한 위험 단어 판정.
// 한국어 사이트뿐 아니라 영문 UI(쿠팡 영문, 해외 쇼핑몰)에서도 걸리도록 영문 단어를 함께 둔다.
export const DEFAULT_DANGER_WORDS = [
  // 한국어
  '결제',
  '구매',
  '송금',
  '이체',
  '삭제',
  '탈퇴',
  '주문',
  // 영어
  'pay',
  'buy',
  'order',
  'checkout',
  'purchase',
  'delete',
  'transfer',
  'withdraw',
  'unsubscribe'
]

export function isDangerous(text: string, words: string[] = DEFAULT_DANGER_WORDS): boolean {
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}

// 사용자 설정 단어와 기본 목록의 합집합(대소문자 무시 중복 제거).
// 설정이 비어 있거나 손상돼도 기본 보호는 절대 사라지지 않는다
export function mergeDangerWords(words: readonly string[] = []): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const w of [...DEFAULT_DANGER_WORDS, ...words]) {
    const v = w.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(v)
  }
  return merged
}
