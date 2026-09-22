// 영역별 사전 정의 도우미 — en 이 ko 와 같은 키를 빠짐없이 갖도록 타입으로 묶는다
export function defineMessages<K extends string>(table: {
  ko: Record<K, string>
  en: Record<K, string>
}): { ko: Record<K, string>; en: Record<K, string> } {
  return table
}
