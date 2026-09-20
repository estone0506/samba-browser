// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  detectCaptchaHint,
  detectSignedInHint,
  matchCaptchaSigns,
  matchSignedInText
} from '../src/preload/login-detect'
import { buildSnapshot, checkKeepSignedIn, matchKeepSignedIn } from '../src/preload/page-core'

describe('matchSignedInText — 로그인 상태 문구 판정', () => {
  it('로그아웃·마이페이지 류를 잡는다(ko)', () => {
    expect(matchSignedInText(['장바구니', '로그아웃']).signedIn).toBe(true)
    expect(matchSignedInText(['마이 페이지']).signedIn).toBe(true)
    expect(matchSignedInText(['내 정보']).signedIn).toBe(true)
    expect(matchSignedInText(['주문내역']).signedIn).toBe(true)
  })

  it('영문 문구도 잡는다(en)', () => {
    expect(matchSignedInText(['Sign out']).signedIn).toBe(true)
    expect(matchSignedInText(['My Account']).signedIn).toBe(true)
    expect(matchSignedInText(['Logout']).signedIn).toBe(true)
  })

  it('로그인·회원가입 링크만 있으면 로그인 전이다', () => {
    const r = matchSignedInText(['로그인', '회원가입', 'Sign in'])
    expect(r.signedIn).toBe(false)
    expect(r.matched).toBe('')
  })

  it('긴 본문 텍스트는 근거로 쓰지 않는다(오탐 방지)', () => {
    const long = '회원님의 주문내역은 마이페이지에서 확인하실 수 있습니다. 자세한 내용은 고객센터로'
    expect(matchSignedInText([long]).signedIn).toBe(false)
  })

  it('판정 근거 문구를 함께 돌려준다', () => {
    expect(matchSignedInText(['홈', '로그아웃']).matched).toBe('로그아웃')
  })
})

describe('detectSignedInHint — DOM 판정', () => {
  it('로그인 폼이 없고 로그아웃 링크가 있으면 로그인된 것으로 본다', () => {
    document.body.innerHTML = `
      <nav><a href="/mypage">마이페이지</a><a href="/logout">로그아웃</a></nav>
      <h1>주문 목록</h1>
    `
    expect(detectSignedInHint().signedIn).toBe(true)
  })

  it('비밀번호 칸이 남아 있으면 로그인된 것으로 보지 않는다', () => {
    document.body.innerHTML = `
      <a href="/logout">로그아웃</a>
      <form><input type="text" name="userId"><input type="password" name="pw"></form>
    `
    expect(detectSignedInHint().signedIn).toBe(false)
  })

  it('숨겨진 로그아웃 링크는 근거가 아니다', () => {
    document.body.innerHTML = `
      <a href="/logout" style="display:none">로그아웃</a>
      <a href="/login">로그인</a>
    `
    expect(detectSignedInHint().signedIn).toBe(false)
  })
})

describe('matchKeepSignedIn / checkKeepSignedIn', () => {
  it('라벨 문구를 ko/en 모두 인식한다', () => {
    expect(matchKeepSignedIn('로그인 상태 유지')).toBe(true)
    expect(matchKeepSignedIn('자동 로그인')).toBe(true)
    expect(matchKeepSignedIn('Keep me signed in')).toBe(true)
    expect(matchKeepSignedIn('Remember me')).toBe(true)
    expect(matchKeepSignedIn('Stay signed in')).toBe(true)
    expect(matchKeepSignedIn('개인정보 수집 동의')).toBe(false)
  })

  it('폼 안의 로그인 상태 유지 체크박스를 켠다', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" name="userId">
        <input type="password" name="pw">
        <label for="keep">로그인 상태 유지</label>
        <input type="checkbox" id="keep">
        <button type="submit">로그인</button>
      </form>
    `
    const snap = buildSnapshot()
    const pwId = snap.elements.find((e) => e.name === 'pw')?.id
    expect(checkKeepSignedIn(pwId)).toMatch(/^checked:/)
    expect(document.querySelector<HTMLInputElement>('#keep')?.checked).toBe(true)
  })

  it('이미 켜져 있으면 끄지 않는다', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="pw">
        <label><input type="checkbox" checked> 자동 로그인</label>
      </form>
    `
    buildSnapshot()
    expect(checkKeepSignedIn()).toMatch(/^already:/)
    expect(document.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true)
  })

  it('다른 체크박스(약관 동의)는 건드리지 않는다', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="pw">
        <label><input type="checkbox" id="terms"> 이용약관 동의</label>
      </form>
    `
    buildSnapshot()
    expect(checkKeepSignedIn()).toBe('none')
    expect(document.querySelector<HTMLInputElement>('#terms')?.checked).toBe(false)
  })

  it('anchor 의 form 밖 체크박스는 건드리지 않는다', () => {
    document.body.innerHTML = `
      <label><input type="checkbox" id="outside"> 자동 로그인</label>
      <form id="f"><input type="password" name="pw"><button type="submit">로그인</button></form>
    `
    const snap = buildSnapshot()
    const pwId = snap.elements.find((e) => e.name === 'pw')?.id
    expect(checkKeepSignedIn(pwId)).toBe('none')
    expect(document.querySelector<HTMLInputElement>('#outside')?.checked).toBe(false)
  })
})

describe('matchCaptchaSigns — 캡차·2FA 징후 판정', () => {
  it('기프트카드 "인증번호" 칸만 있는 주문서는 캡차로 보지 않는다', () => {
    const r = matchCaptchaSigns({
      text: '기프트카드 입력 테이블로 카드번호, 인증번호, 잔액, 현금영수증 발급 을(를) 나타낸 표입니다. 카드번호 인증번호 잔액 조회 결제수단 선택',
      frameSources: [],
      hasCodeInput: true
    })
    expect(r.needsUser).toBe(false)
  })

  it('문자 인증번호 발송 문구는 사람에게 넘긴다', () => {
    const r = matchCaptchaSigns({
      text: '휴대폰 번호를 입력하고 인증번호 발송을 누르세요',
      frameSources: [],
      hasCodeInput: true
    })
    expect(r.needsUser).toBe(true)
  })

  const base = { text: '', frameSources: [] as string[], hasCodeInput: false }

  it('캡차 iframe 은 그 자체로 넘김 대상', () => {
    const r = matchCaptchaSigns({
      ...base,
      frameSources: ['https://www.google.com/recaptcha/api2/anchor?k=abc']
    })
    expect(r.needsUser).toBe(true)
    expect(r.matched).toMatch(/captcha frame/)
  })

  it('강한 문구는 입력칸이 없어도 넘김 대상', () => {
    expect(matchCaptchaSigns({ ...base, text: '캡차를 입력하세요' }).needsUser).toBe(true)
    expect(matchCaptchaSigns({ ...base, text: "I'm not a robot" }).needsUser).toBe(true)
    expect(
      matchCaptchaSigns({ ...base, text: '보안을 위해 추가 확인이 필요합니다' }).needsUser
    ).toBe(true)
  })

  it('약한 문구는 인증번호 입력칸이 함께 있을 때만 넘김 대상', () => {
    const text = '인증번호를 입력해 주세요'
    expect(matchCaptchaSigns({ ...base, text }).needsUser).toBe(false)
    expect(matchCaptchaSigns({ ...base, text, hasCodeInput: true }).needsUser).toBe(true)
  })

  it('영수증·주문 화면을 캡차로 오인하지 않는다', () => {
    const text = '주문이 완료되었습니다. 영수증을 확인하세요'
    expect(matchCaptchaSigns({ ...base, text }).needsUser).toBe(false)
  })

  it('평범한 페이지는 넘김 대상이 아니다', () => {
    const r = matchCaptchaSigns({ ...base, text: '장바구니에 담긴 상품이 없습니다' })
    expect(r.needsUser).toBe(false)
    expect(r.matched).toBe('')
  })
})

describe('detectCaptchaHint — DOM 판정', () => {
  it('recaptcha iframe 이 있으면 사용자 확인이 필요하다', () => {
    document.body.innerHTML = `<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>`
    expect(detectCaptchaHint().needsUser).toBe(true)
  })

  it('인증번호 입력칸 + 문구면 사용자 확인이 필요하다', () => {
    document.body.innerHTML = `
      <p>인증번호를 입력해 주세요</p>
      <input type="text" name="otp" placeholder="인증번호">
    `
    expect(detectCaptchaHint().needsUser).toBe(true)
  })

  it('로그인 성공 화면은 사용자 확인이 필요 없다', () => {
    document.body.innerHTML = `<p>환영합니다</p><a href="/logout">로그아웃</a>`
    expect(detectCaptchaHint().needsUser).toBe(false)
  })
})
