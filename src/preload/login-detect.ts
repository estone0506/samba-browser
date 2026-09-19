// 로그인 폼 탐지 엔진 (오픈소스 비밀번호 관리자 규칙 이식).
//
// [규칙] 이 파일은 page.ts / page-core.ts 와 함께 sandbox preload 로 번들된다.
// src/shared/* 에서 **값(value)** 을 import 하지 말 것(타입만 `import type`).
// 상대 경로 import 는 같은 엔트리에 인라인되므로 안전하다.
//
// --- 출처 및 라이선스 ------------------------------------------------------
// 정규식 상수 일부는 The Chromium Project (BSD-3-Clause) 에서 가져왔다.
//   - components/autofill/core/common/autofill_regex_constants.cc 의 kEmailRe
//   - components/password_manager/core/common/password_manager_constants.h 의
//     kPasswordRe / kOneTimePwdRe / kSearch
//   Copyright 2013 The Chromium Authors. Use of this source code is governed by
//   a BSD-style license. 전문은 resources/licenses/LICENSE-chromium.txt 참고.
//   한국어 패턴(아이디, 사용자명, 이메일, 비밀번호, 비번, 인증번호 등)과
//   그 밖의 필드명 패턴은 우리가 직접 덧붙였다.
//
// 후보 선택·가시성 판정 로직은 이 저장소의 독자 설계다. 어떤 비밀번호 관리자
// 구현에서도 코드를 가져오지 않았고, 웹 표준(autocomplete 토큰)과 업계에
// 널리 알려진 공개 관행만 참고했다. 자세한 감사 결과는 THIRD_PARTY_NOTICES.md 참고.

// 탐지 단계. 2단계 로그인(아이디 화면 → 비밀번호 화면)을 호출부가 구분할 수 있게 한다
export type LoginStage = 'single' | 'username-only' | 'password-only' | 'none'

// 이미 로그인된 상태인지에 대한 힌트(로그인 폼이 없을 때만 의미가 있다)
export interface SignedInHint {
  signedIn: boolean
  // 판정 근거가 된 문구(모델·로그에 남긴다). 못 찾으면 빈 문자열
  matched: string
}

// 사람이 직접 처리해야 하는 추가 확인(캡차·2FA) 징후.
// AI 가 대신 풀지 않는다 — 사용자에게 넘기기 위한 "감지" 전용 정보다
export interface CaptchaHint {
  needsUser: boolean
  matched: string
}

export interface LoginFields {
  username?: number
  password?: number
  submit?: number
  stage: LoginStage
  // 0~1. 높을수록 확실한 로그인 폼(autocomplete 힌트/제출 버튼이 있으면 올라간다)
  confidence: number
  // 현재 문서가 iframe 안인지(메인 프레임이 아니면 로그인 폼이 다른 프레임에 있을 수 있다)
  iframe: boolean
}

// --- 정규식 상수 -----------------------------------------------------------

// Chromium kEmailRe (BSD-3) + 한국어 보강
export const EMAIL_RE =
  /e.?mail|courriel|correo.*electr(o|ó)nico|メールアドレス|Электронной.?Почты|邮件|邮箱|電郵地址|(\b|_)eposta(\b|_)|이메일|전자.?우편|메일.?주소/i

// Chromium kNameIgnoredRe(user.?name|user.?id 계열) + 한국 사이트에서 실제로 쓰는 필드명
export const USERNAME_RE =
  /user.?(name|id|nm)|userid|login.?(id|name)|customer.?id|member.?id|account.?(id|name)|benutzer.?(name|id)|nickname|screen.?name|아이디|사용자.?(명|이름|아이디)|회원.?(아이디|번호)|계정/i

// Chromium kPasswordRe (BSD-3) + 한국어
export const PASSWORD_RE =
  /pass(?:word|code)|pas(?:word|code)|pswrd|psw|pswd|pwd|parole|watchword|pasahitza|parol|lozinka|sifr|contrasenya|heslo|adgangskode|losen|wachtwoord|paswoord|salasana|passe|contrasinal|passwort|jelszo|sandi|signum|slaptazodis|kata|passord|haslo|senha|geslo|contrasena|khau|비밀.?번호|비번|암호/i

// 신규 비밀번호(회원가입/변경) — 로그인 대상에서 제외한다
export const NEW_PASSWORD_RE =
  /new.?pass|change.?pass|create.?pass|set.?pass|register.?pass|새.?비밀.?번호|신규.?비밀.?번호|비밀.?번호.?변경|비밀.?번호.?재설정/i

// 비밀번호 확인칸 — 로그인 대상에서 제외한다
export const CONFIRM_PASSWORD_RE =
  /confirm|re.?enter|re.?type|repeat|verify.?pass|again|비밀.?번호.?확인|비밀.?번호.?재입력|한번.?더/i

// Chromium kOneTimePwdRe (BSD-3) + 한국어
export const ONE_TIME_PASSWORD_RE =
  /one.?time|(?:\b|_)(?:otp|otc|totp|sms|2fa|mfa)(?:\b|_)|(?:otp|otc|totp|sms|2fa|mfa).?(?:code|token|input|val|pin|login|verif|pass|pwd|psw|auth|field)|(?:verif(?:y|ication)?|email|phone|text|login|input|txt|user).?(?:otp|otc|totp|sms|2fa|mfa)|sms.?otp|mfa.?otp|verif(?:y|ication)?.?code|(?:\b|_)vcode|(?:second|two|2).?factor|wfls-token|email_code|인증.?(번호|코드)|일회용.?비밀.?번호|보안.?문자/i

// Chromium kSearch + 검색창에 흔한 일반 명사 + 한국어
export const SEARCH_RE = /search|query|keyword|\bfind\b|검색|찾기/i

// 소셜 로그인 버튼(우리 자격 증명으로 제출할 대상이 아니다)
export const SOCIAL_RE =
  /naver|kakao|google|facebook|apple|line|github|twitter|wechat|payco|toss|sns|oauth|social|네이버|카카오|구글|페이스북|애플|라인|깃허브|트위터|간편/i

// 제출 버튼 텍스트
export const SUBMIT_TEXT_RE = /로그인하기|로그인|login|log.?in|sign.?in|계속|다음|continue|next/i

// 허니팟(봇 함정) 이름 패턴
const HONEYPOT_RE = /honey|\btrap\b|nospam|no.?bot|bot.?field|fake.?(field|input)/i

// 로그인된 사용자에게만 보이는 링크·버튼 문구(ko/en)
export const SIGNED_IN_RE =
  /로그아웃|마이\s?페이지|내\s?정보|내\s?계정|내\s?정보\s?관리|주문\s?내역|sign\s?out|log\s?out|logout|my\s?page|my\s?account|my\s?info|my\s?profile/i

// 로그인 화면임을 알리는 문구. 이런 링크만 있으면 로그인된 상태로 보지 않는다
export const SIGNED_OUT_RE = /로그인|회원가입|sign\s?in|sign\s?up|log\s?in|create\s?account/i

// 사람이 직접 풀어야 하는 확인의 강한 징후 — 이 문구 하나로 넘김을 결정한다
export const CAPTCHA_STRONG_RE =
  /캡차|captcha|보안을?\s?위해\s?추가\s?확인|추가\s?인증이?\s?필요|로봇이\s?아닙니다|i'?m\s?not\s?a\s?robot|security\s?check/i

// 약한 징후 — 일상적인 주문·영수증 화면에도 나오는 말이라
// 입력칸(인증번호 칸)이 함께 있을 때만 넘김으로 본다
export const CAPTCHA_WEAK_RE =
  /인증번호|영수증|2단계|2차\s?인증|verification\s?code|one.?time\s?code|two.?factor/i

// 캡차 위젯 iframe 의 주소 패턴
export const CAPTCHA_FRAME_RE = /recaptcha|hcaptcha|turnstile|funcaptcha|geetest/i

// --- DOM 유틸 --------------------------------------------------------------

type FormOwner = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement

export function formOf(el: HTMLElement): HTMLFormElement | null {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return (el as FormOwner).form
  }
  return null
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

// 가시성 판정. jsdom 은 레이아웃을 계산하지 않아 크기/offsetParent 를 신뢰할 수
// 없으므로, 우리는 계산된 스타일(display·visibility·opacity·clip·화면 밖 배치)과
// 속성(hidden·aria-hidden·type=hidden)만으로 판단한다.
export function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  let node: HTMLElement | null = el
  while (node) {
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    if (cs.opacity !== '' && Number(cs.opacity) === 0) return false
    // clip / 화면 밖 배치로 숨긴 경우
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)') return false
    const left = parseFloat(cs.left)
    const top = parseFloat(cs.top)
    if (cs.position === 'absolute' && (left <= -9999 || top <= -9999)) return false
    node = node.parentElement
  }
  return true
}

// 허니팟: 보이지 않거나 이름이 함정 패턴인 입력칸
export function isHoneypot(el: HTMLInputElement): boolean {
  if (!isVisible(el)) return true
  const hay = `${el.name} ${el.id} ${el.className}`
  return HONEYPOT_RE.test(hay)
}

// 요소에 붙은 사람이 읽는 텍스트: aria-label / label[for] / aria-labelledby /
// placeholder / name / id / 인접 텍스트
export function labelTextOf(el: HTMLElement): string {
  const parts: string[] = []
  const push = (v: string | null | undefined): void => {
    if (v) parts.push(v)
  }
  push(el.getAttribute('aria-label'))
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      push(document.getElementById(id)?.textContent)
    }
  }
  if (el.id) {
    const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`)
    push(lab?.textContent)
  }
  push(el.closest('label')?.textContent)
  push(el.getAttribute('placeholder'))
  push(el.getAttribute('name'))
  push(el.id)
  push(el.getAttribute('title'))
  // 바로 앞 형제 텍스트(라벨 대신 span/div 를 쓰는 폼 대비)
  const prev = el.previousElementSibling
  if (prev && !prev.querySelector?.('input')) push(prev.textContent)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function autocompleteOf(el: HTMLElement): string {
  return (el.getAttribute('autocomplete') || '').toLowerCase().trim()
}

function isTextishInput(el: HTMLInputElement): boolean {
  // type=tel 아이디(휴대폰 번호 로그인)도 허용한다
  return el.type === 'text' || el.type === 'email' || el.type === 'tel' || el.type === ''
}

function allInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
}

// --- 비밀번호 후보 ---------------------------------------------------------

function isLoginPasswordField(el: HTMLInputElement): boolean {
  const auto = autocompleteOf(el)
  if (auto.includes('new-password')) return false
  if (auto.includes('current-password')) return true
  const hay = labelTextOf(el)
  if (NEW_PASSWORD_RE.test(hay) || CONFIRM_PASSWORD_RE.test(hay)) return false
  return true
}

export function passwordElement(): HTMLInputElement | undefined {
  const pws = allInputs().filter((el) => el.type === 'password' && !isHoneypot(el))
  if (pws.length === 0) return undefined
  const current = pws.find((el) => autocompleteOf(el).includes('current-password'))
  if (current) return current
  return pws.find(isLoginPasswordField) ?? pws[0]
}

// --- 사용자명 후보 ---------------------------------------------------------

function isUsernameLike(el: HTMLInputElement): boolean {
  const auto = autocompleteOf(el)
  if (auto === 'username' || auto === 'email' || auto === 'tel') return true
  if (el.type === 'email') return true
  const hay = labelTextOf(el)
  if (ONE_TIME_PASSWORD_RE.test(hay) || SEARCH_RE.test(hay)) return false
  return USERNAME_RE.test(hay) || EMAIL_RE.test(hay)
}

function isUsableCandidate(el: HTMLInputElement): boolean {
  if (!isTextishInput(el)) return false
  if (el.disabled || el.readOnly) return false
  if (isHoneypot(el)) return false
  const hay = labelTextOf(el)
  if (SEARCH_RE.test(hay) && !isUsernameLike(el)) return false
  if (ONE_TIME_PASSWORD_RE.test(hay)) return false
  return true
}

// 아이디 칸 후보의 점수 계산에 필요한 기준값
interface UsernameScoreContext {
  // 비밀번호 칸이 속한 form(없으면 null)
  form: HTMLFormElement | null
  // 비밀번호 칸과 몇 칸 떨어져 있는지(1 = 바로 앞)
  distance: number
}

// 폼 경계가 같으면 주는 점수. 이 점수가 없으면 사실상 탈락이므로
// "같은 폼(또는 둘 다 폼 밖)" 이 사실상의 1차 관문 역할을 한다
const SCORE_SAME_FORM = 30

/**
 * 아이디 칸다움을 점수로 환산한다(우리 방식: 가중치 합산 랭킹).
 * 근거를 하나씩 더하고 비밀번호 칸에서 먼 만큼 깎아, 한 화면에 입력칸이
 * 여럿이어도 "가장 아이디 칸다운" 하나가 남게 한다.
 */
function scoreUsernameCandidate(el: HTMLInputElement, ctx: UsernameScoreContext): number {
  let score = 0

  // 1) 웹 표준 autocomplete 힌트가 가장 확실한 근거다
  const auto = autocompleteOf(el)
  if (auto === 'username') score += 50
  else if (auto === 'email' || auto === 'tel') score += 40

  // 2) 비밀번호 칸과 같은 폼 경계(둘 다 폼 밖인 SPA 도 같은 경계로 본다)
  if (formOf(el) === ctx.form) score += SCORE_SAME_FORM

  // 3) 이름·라벨·placeholder 에 아이디/이메일 낱말이 있는가
  const hay = labelTextOf(el)
  if (USERNAME_RE.test(hay)) score += 25
  else if (EMAIL_RE.test(hay)) score += 20

  // 4) input type 자체가 아이디로 쓰이는 형태인가
  if (el.type === 'email' || el.type === 'tel') score += 10

  // 5) 비밀번호 칸에서 멀수록 감점(최대 10점). 같은 점수대면 가까운 칸이 이긴다
  score -= Math.min(ctx.distance, 10)

  return score
}

/**
 * 비밀번호 칸을 기준으로 짝이 되는 아이디 칸을 고른다.
 * 비밀번호 칸보다 앞에 있는 입력칸만 후보로 삼고, 각 후보를 점수로 매겨
 * 최고점 하나를 고른다. 점수가 0 이하면(= 폼도 다르고 아이디 낱말도 없으면)
 * 아이디 칸이 없는 것으로 본다.
 */
export function usernameElementFor(passwordEl: HTMLInputElement): HTMLInputElement | undefined {
  const inputs = allInputs()
  const pwPos = inputs.indexOf(passwordEl)
  if (pwPos === -1) return undefined
  const pwForm = formOf(passwordEl)

  let best: HTMLInputElement | undefined
  let bestScore = 0

  for (let i = 0; i < pwPos; i++) {
    const el = inputs[i]
    if (!isUsableCandidate(el)) continue
    const score = scoreUsernameCandidate(el, { form: pwForm, distance: pwPos - i })
    if (score > bestScore) {
      best = el
      bestScore = score
    }
  }

  return best
}

// 비밀번호 칸이 없는 화면(2단계 로그인 1단계)의 아이디 칸
export function standaloneUsernameElement(): HTMLInputElement | undefined {
  const candidates = allInputs().filter(isUsableCandidate)
  return candidates.find(isUsernameLike)
}

// --- 제출 버튼 -------------------------------------------------------------

function isSubmitLike(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type === 'submit'
  if (el.tagName === 'BUTTON') return (el as HTMLButtonElement).type !== 'button'
  return false
}

function isButtonish(el: HTMLElement): boolean {
  return (
    el.tagName === 'BUTTON' ||
    (el.tagName === 'INPUT' &&
      ((el as HTMLInputElement).type === 'submit' || (el as HTMLInputElement).type === 'button')) ||
    el.getAttribute('role') === 'button'
  )
}

function buttonTextOf(el: HTMLElement): string {
  const input = el as HTMLInputElement
  const value = el.tagName === 'INPUT' ? input.value : ''
  return `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''} ${value} ${el.className} ${el.id}`
    .replace(/\s+/g, ' ')
    .trim()
}

// 소셜 로그인 버튼은 제출 대상이 아니다
function isSocialButton(el: HTMLElement): boolean {
  return SOCIAL_RE.test(buttonTextOf(el))
}

// registry(현재 스냅샷) 안에서 제출 버튼의 id(1-base)를 찾는다
export function findSubmit(registry: HTMLElement[], anchor?: HTMLElement): number | undefined {
  const form = anchor ? formOf(anchor) : null
  if (form) {
    for (let i = 0; i < registry.length; i++) {
      const el = registry[i]
      if (formOf(el) !== form) continue
      if (!isSubmitLike(el)) continue
      if (isSocialButton(el)) continue
      return i + 1
    }
  }
  for (let i = 0; i < registry.length; i++) {
    const el = registry[i]
    if (!isButtonish(el)) continue
    if (isSocialButton(el)) continue
    if (!SUBMIT_TEXT_RE.test(buttonTextOf(el))) continue
    return i + 1
  }
  return undefined
}

// --- 전체 탐지 -------------------------------------------------------------

function inIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self
  } catch {
    // 교차 출처라 window.top 접근이 막히면 iframe 안이다
    return true
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function detectLoginFields(registry: HTMLElement[]): LoginFields {
  const iframe = inIframe()
  const pwEl = passwordElement()

  if (pwEl) {
    const pwIdx = registry.indexOf(pwEl)
    const userEl = usernameElementFor(pwEl)
    const userIdx = userEl ? registry.indexOf(userEl) : -1
    const submit = findSubmit(registry, pwEl)
    let confidence = 0.35
    if (userIdx !== -1) confidence += 0.3
    if (submit !== undefined) confidence += 0.15
    if (autocompleteOf(pwEl).includes('current-password')) confidence += 0.1
    if (userEl && (autocompleteOf(userEl) === 'username' || autocompleteOf(userEl) === 'email')) {
      confidence += 0.1
    }
    return {
      username: userIdx === -1 ? undefined : userIdx + 1,
      password: pwIdx === -1 ? undefined : pwIdx + 1,
      submit,
      stage: userIdx === -1 ? 'password-only' : 'single',
      confidence: round2(Math.min(confidence, 1)),
      iframe
    }
  }

  const userEl = standaloneUsernameElement()
  if (userEl) {
    const userIdx = registry.indexOf(userEl)
    if (userIdx !== -1) {
      const submit = findSubmit(registry, userEl)
      let confidence = 0.4
      if (submit !== undefined) confidence += 0.15
      const auto = autocompleteOf(userEl)
      if (auto === 'username' || auto === 'email') confidence += 0.1
      return {
        username: userIdx + 1,
        submit,
        stage: 'username-only',
        confidence: round2(Math.min(confidence, 1)),
        iframe
      }
    }
  }

  return { stage: 'none', confidence: 0, iframe }
}

// --- 로그인 상태 힌트 -------------------------------------------------------

/**
 * 링크·버튼 문구 목록에서 "이미 로그인됨" 근거를 찾는다(순수 함수).
 * 로그아웃/마이페이지 류가 하나라도 있으면 로그인된 것으로 본다.
 * 반대로 로그인/회원가입 링크만 있으면 로그인 전 화면이다
 */
export function matchSignedInText(texts: string[]): SignedInHint {
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t || t.length > 40) continue
    if (SIGNED_IN_RE.test(t)) return { signedIn: true, matched: t }
  }
  return { signedIn: false, matched: '' }
}

/**
 * 현재 문서가 로그인된 상태로 보이는지. 로그인 폼이 남아 있으면 무조건 아니다.
 * 호출부(login 도구)는 findLoginFields 가 폼을 못 찾았을 때만 이 값을 쓴다
 */
export function detectSignedInHint(): SignedInHint {
  if (passwordElement()) return { signedIn: false, matched: '' }
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"]')
  ).filter(isVisible)
  const texts = nodes.map(
    (el) => el.getAttribute('aria-label') || el.innerText || el.textContent || ''
  )
  return matchSignedInText(texts)
}

// --- 캡차·2FA 징후 ----------------------------------------------------------

/**
 * 캡차·2FA 징후 판정(순수 함수).
 * - 강한 문구나 캡차 iframe 은 그 자체로 넘김 대상
 * - 약한 문구(인증번호·영수증 등)는 인증번호 입력칸이 함께 있을 때만 넘김 대상
 * 캡차를 푸는 것은 언제나 사용자 몫이다. 이 함수는 "사람이 필요하다"만 판정한다
 */
export function matchCaptchaSigns(input: {
  text: string
  frameSources: string[]
  hasCodeInput: boolean
}): CaptchaHint {
  const frame = input.frameSources.find((src) => CAPTCHA_FRAME_RE.test(src))
  if (frame) return { needsUser: true, matched: `captcha frame (${frame.slice(0, 60)})` }
  const strong = CAPTCHA_STRONG_RE.exec(input.text)
  if (strong) return { needsUser: true, matched: strong[0] }
  if (input.hasCodeInput) {
    const weak = CAPTCHA_WEAK_RE.exec(input.text)
    if (weak) return { needsUser: true, matched: weak[0] }
  }
  return { needsUser: false, matched: '' }
}

// 인증번호(1회용 비밀번호) 입력칸으로 보이는 칸이 있는가
function hasCodeInput(): boolean {
  return allInputs().some((el) => {
    if (!isVisible(el)) return false
    if (el.type === 'password') return false
    if (ONE_TIME_PASSWORD_RE.test(labelTextOf(el))) return true
    const len = Number(el.getAttribute('maxlength'))
    return el.inputMode === 'numeric' && Number.isFinite(len) && len > 0 && len <= 8
  })
}

/** 현재 문서에 캡차·2FA 징후가 있는지 */
export function detectCaptchaHint(): CaptchaHint {
  const text = (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000)
  const frameSources = Array.from(document.querySelectorAll('iframe')).map(
    (f) => f.getAttribute('src') || f.getAttribute('title') || ''
  )
  return matchCaptchaSigns({ text, frameSources, hasCodeInput: hasCodeInput() })
}
