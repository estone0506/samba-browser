import { describe, it, expect } from 'vitest'
import {
  checkHarnessGate,
  classifyLoginOutcome,
  maskUsername,
  sanitizeNote
} from '../src/main/e2e/login-harness'
import type { AccountDto } from '../src/shared/vault'

describe('classifyLoginOutcome', () => {
  it('로그인 페이지를 벗어나고 로그아웃 문구가 보이면 성공', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/main',
        '마이페이지 로그아웃 장바구니'
      )
    ).toBe('success')
  })

  it('보안문자 안내가 있으면 캡차', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/login',
        '보안문자를 입력해 주세요'
      )
    ).toBe('captcha')
  })

  it('인증번호 안내가 있으면 2단계 인증', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/otp',
        '휴대폰으로 전송된 인증번호를 입력하세요'
      )
    ).toBe('2fa')
  })

  it('비밀번호 불일치 문구가 있으면 비밀번호 오류', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/login',
        '아이디 또는 비밀번호가 일치하지 않습니다'
      )
    ).toBe('wrong_password')
  })

  it('alert 로만 알려 주는 "확인하세요" 문구도 비밀번호 오류로 본다', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/login',
        '아이디 또는 패스워드를 확인하세요.'
      )
    ).toBe('wrong_password')
  })

  it('외부 SSO 제공자로 넘어가면 sso_redirect', () => {
    expect(
      classifyLoginOutcome('https://shop.co.kr/login', 'https://accounts.google.com/signin', '계속')
    ).toBe('sso_redirect')
  })

  it('같은 사이트의 로그인 서브도메인 이동은 SSO 가 아니다', () => {
    expect(
      classifyLoginOutcome(
        'https://www.naver.com/',
        'https://nid.naver.com/nidlogin.login',
        '로그인'
      )
    ).toBe('unknown')
  })

  it('접근 차단 문구가 있으면 blocked', () => {
    expect(
      classifyLoginOutcome(
        'https://example.com/login',
        'https://example.com/login',
        'Access Denied'
      )
    ).toBe('blocked')
  })

  it('판단 근거가 없으면 unknown', () => {
    expect(
      classifyLoginOutcome('https://example.com/login', 'https://example.com/login', '비밀번호')
    ).toBe('unknown')
  })

  it('차단이 캡차보다 우선한다', () => {
    expect(
      classifyLoginOutcome('https://example.com/login', 'https://example.com/login', '403 captcha')
    ).toBe('blocked')
  })
})

describe('sanitizeNote / maskUsername', () => {
  it('비밀값을 *** 로 치환한다', () => {
    expect(sanitizeNote('로그인 실패: hunter2 거부', ['hunter2'])).toBe('로그인 실패: *** 거부')
  })

  it('3글자 미만 값은 오탐 방지를 위해 치환하지 않는다', () => {
    expect(sanitizeNote('ab 오류', ['ab'])).toBe('ab 오류')
  })

  it('개행과 파이프를 제거해 표를 깨뜨리지 않는다', () => {
    expect(sanitizeNote('a\nb|c', [])).toBe('a b/c')
  })

  it('사용자명은 앞 2글자만 남긴다', () => {
    expect(maskUsername('hongildong')).toBe('ho***')
  })
})

describe('checkHarnessGate', () => {
  const account = (over: Partial<AccountDto> = {}): AccountDto => ({
    id: 1,
    siteId: 1,
    host: 'nid.naver.com',
    label: '네이버',
    username: 'hongildong',
    isDefault: true,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: [],
    ...over
  })

  it('https·같은 등록 도메인이면 통과한다', () => {
    expect(checkHarnessGate({}, account(), 'https://www.naver.com/login')).toBeNull()
  })

  it('평문(http) 페이지는 거부한다', () => {
    expect(checkHarnessGate({}, account(), 'http://www.naver.com/login')).toBe('insecure-page')
  })

  it('제외 도메인은 거부한다(서브도메인 포함)', () => {
    expect(
      checkHarnessGate({ excludedHosts: () => ['naver.com'] }, account(), 'https://nid.naver.com/')
    ).toBe('excluded')
  })

  it('전역 접근 정책이 never 면 거부한다', () => {
    expect(
      checkHarnessGate({ vaultAccessPolicy: () => 'never' }, account(), 'https://www.naver.com/')
    ).toBe('access-never')
  })

  it('계정별 agentAccess 가 전역 정책을 덮어쓴다', () => {
    expect(
      checkHarnessGate(
        { vaultAccessPolicy: () => 'never' },
        account({ agentAccess: 'while_unlocked' }),
        'https://www.naver.com/'
      )
    ).toBeNull()
    expect(checkHarnessGate({}, account({ agentAccess: 'never' }), 'https://www.naver.com/')).toBe(
      'access-never'
    )
  })

  it('계정과 다른 등록 도메인이면 거부한다', () => {
    expect(checkHarnessGate({}, account(), 'https://www.daum.net/')).toBe('host-mismatch')
  })
})
