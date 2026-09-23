// 탭 프로필(계정별 세션) 색 — 같은 이름은 언제나 같은 색이라 탭 바·사이드바에서 한눈에 구분된다.
// 기본 프로필은 색이 없다(평범한 탭).

export const DEFAULT_PROFILE = 'default'

// 서로 잘 구분되는 색상(hue) 12개 — 채도·명도는 고정해 밝은/어두운 테마 어디서든 읽힌다
const HUES = [212, 28, 142, 340, 262, 48, 186, 0, 96, 300, 168, 76]

/** 프로필 이름 → 0..HUES.length-1 의 안정 색인(단순 문자열 해시) */
export function profileHueIndex(profile: string): number {
  let h = 0
  for (const ch of profile) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return h % HUES.length
}

/** 기본 프로필이면 null, 아니면 그 프로필의 CSS 색(hsl). 같은 이름은 항상 같은 색 */
export function profileColor(profile: string | undefined): string | null {
  if (!profile || profile === DEFAULT_PROFILE) return null
  return `hsl(${HUES[profileHueIndex(profile)]} 70% 45%)`
}

/** 배지 배경용 옅은 색(같은 색상, 낮은 불투명도) */
export function profileTint(profile: string | undefined): string | null {
  if (!profile || profile === DEFAULT_PROFILE) return null
  return `hsl(${HUES[profileHueIndex(profile)]} 70% 45% / 0.15)`
}
