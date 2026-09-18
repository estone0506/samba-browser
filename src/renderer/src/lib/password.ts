// 비밀번호 생성 순수 함수. 컴포넌트와 분리해 두어 단위 테스트가 가능하다.

// 길이 범위(생성기 슬라이더와 동일)
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 32
export const DEFAULT_PASSWORD_LENGTH = 16

// 헷갈리는 글자(l/I/1, O/0)는 뺀다
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{}<>?'

export interface GeneratePasswordOptions {
  length: number
  symbols: boolean
  digits: boolean
}

/**
 * 비밀번호를 만든다 — crypto.getRandomValues 만 쓴다(Math.random 금지).
 * 모듈로 편향을 없애기 위해 알파벳 길이의 배수를 넘는 난수는 버리고 다시 뽑는다.
 */
export function generatePassword(opts: GeneratePasswordOptions): string {
  const length = Math.min(
    MAX_PASSWORD_LENGTH,
    Math.max(MIN_PASSWORD_LENGTH, Math.round(opts.length))
  )
  let alphabet = LOWER + UPPER
  if (opts.digits) alphabet += DIGITS
  if (opts.symbols) alphabet += SYMBOLS
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  const out: string[] = []
  const buf = new Uint8Array(1)
  while (out.length < length) {
    crypto.getRandomValues(buf)
    // 편향 구간의 값은 버린다
    if (buf[0] >= limit) continue
    out.push(alphabet[buf[0] % alphabet.length])
  }
  return out.join('')
}
