import { describe, it, expect } from 'vitest'
import { isLoginSuccess } from '../src/main/ipc/login-success'

const LOGIN_URL = 'https://www.shop.example/login?next=/mypage'
const HOME_URL = 'https://www.shop.example/mypage'

describe('isLoginSuccess', () => {
  it('로그인 페이지를 벗어나고 실패 문구가 없으면 성공으로 본다', () => {
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, '반갑습니다, alice 님')).toBe(true)
  })

  it('URL 이 그대로면(제출 후에도 같은 페이지) 실패로 본다', () => {
    expect(isLoginSuccess(LOGIN_URL, LOGIN_URL, '반갑습니다')).toBe(false)
  })

  it('새 URL 에 여전히 로그인 경로가 남아 있으면 실패로 본다', () => {
    expect(isLoginSuccess(LOGIN_URL, 'https://www.shop.example/login?error=1', '')).toBe(false)
    expect(isLoginSuccess(LOGIN_URL, 'https://accounts.shop.example/signin', '')).toBe(false)
  })

  it('페이지 텍스트에 한국어 실패 문구가 있으면 실패로 본다', () => {
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, '비밀번호가 일치하지 않습니다')).toBe(false)
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, '아이디 또는 비밀번호가 틀렸습니다')).toBe(false)
  })

  it('페이지 텍스트에 영어 실패 문구가 있으면 실패로 본다', () => {
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, 'Incorrect password. Please try again.')).toBe(false)
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, 'Invalid credentials')).toBe(false)
  })

  it('실패 문구가 3000자 이후에만 있으면 검사 범위 밖이라 성공으로 본다', () => {
    const padding = 'x'.repeat(3000)
    const text = `${padding}incorrect password`
    expect(isLoginSuccess(LOGIN_URL, HOME_URL, text)).toBe(true)
  })
})
