// 네이버페이 결제창(pay.naver.com)의 로그인 계정 검사.
// 네이버페이는 네이버 계정으로 결제되는데, 결제창은 브라우저에 로그인돼 있던 네이버 계정을 그대로 쓴다 —
// 키마스터에서 고른 계정(mjkim88)과 다른 계정(mjki******)으로 결제되면 안 되므로 결제창 우측 위의
// 마스킹된 아이디를 읽어 반드시 맞춰 본다. 마스킹은 "앞 4글자 + ******" 꼴이다

/** 네이버페이 결제창 호스트인가(m.pay.naver.com · pay.naver.com …) */
export function isNaverPayHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'pay.naver.com' || h.endsWith('.pay.naver.com')
}

/**
 * 결제창 본문에서 마스킹된 로그인 아이디(예: "mjki******")를 찾는다.
 * 보이는 앞부분과 별표 개수를 그대로 돌려준다. 없으면 null
 */
export function maskedNaverAccount(text: string): string | null {
  const m = /(?:^|[^\w@.-])([A-Za-z0-9][A-Za-z0-9._-]{0,30})(\*{3,})(?![\w*])/.exec(text)
  if (!m) return null
  return `${m[1]}${m[2]}`
}

/**
 * 마스킹된 아이디가 기대 아이디(키마스터 계정)와 같은 계정인가.
 * 보이는 앞부분이 아이디 앞부분과 같아야 한다(대소문자 무시). 이메일 아이디는 @ 앞부분으로 본다.
 * 보이는 글자 수가 아이디보다 길면(다른 계정) false
 */
export function maskedNaverAccountMatches(masked: string, username: string): boolean {
  const visible = masked.replace(/\*+$/, '').toLowerCase()
  if (!visible) return false
  const id = username.trim().toLowerCase().split('@')[0]
  if (!id || visible.length > id.length) return false
  return id.startsWith(visible)
}
