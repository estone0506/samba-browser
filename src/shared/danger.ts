// 실행 전 사용자 확인이 필요한 위험 단어 판정
export const DEFAULT_DANGER_WORDS = ['결제', '구매', '송금', '이체', '삭제', '탈퇴', '주문']

export function isDangerous(text: string, words: string[] = DEFAULT_DANGER_WORDS): boolean {
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}
