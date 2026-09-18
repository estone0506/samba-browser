import { describe, it, expect } from 'vitest'
import { isAllowedUrl, isHttpUrl, BLOCKED_URL_MESSAGE } from '../src/shared/url'
import { toUrl } from '../src/main/browser/tab-manager'

describe('isAllowedUrl', () => {
  it('http/https 는 허용', () => {
    expect(isAllowedUrl('https://www.google.com')).toBe(true)
    expect(isAllowedUrl('http://example.com/a?b=1')).toBe(true)
  })
  it('about:blank 은 허용', () => {
    expect(isAllowedUrl('about:blank')).toBe(true)
    expect(isAllowedUrl('ABOUT:BLANK')).toBe(true)
  })
  it('file: 은 거부', () => {
    expect(isAllowedUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedUrl('FILE:///etc/passwd')).toBe(false)
  })
  it('javascript: 는 거부', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false)
  })
  it('data: 는 거부', () => {
    expect(isAllowedUrl('data:text/html,<h1>hi</h1>')).toBe(false)
  })
  it('about:blank 이외의 about: 은 거부', () => {
    expect(isAllowedUrl('about:config')).toBe(false)
  })
  it('빈 문자열·비 URL 은 거부', () => {
    expect(isAllowedUrl('')).toBe(false)
    expect(isAllowedUrl('   ')).toBe(false)
    expect(isAllowedUrl('그냥 검색어')).toBe(false)
  })
  it('앞뒤 공백은 무시한다', () => {
    expect(isAllowedUrl('  https://a.com  ')).toBe(true)
    expect(isAllowedUrl('  file:///a  ')).toBe(false)
  })
})

describe('isHttpUrl', () => {
  it('about:blank 은 외부 열기 대상이 아니다', () => {
    expect(isHttpUrl('about:blank')).toBe(false)
    expect(isHttpUrl('https://a.com')).toBe(true)
  })
})

describe('toUrl 결과는 항상 허용 목록을 통과한다', () => {
  for (const input of [
    'naver.com',
    '삼바웨이브',
    'https://a.com/x',
    'file:///C:/Windows/win.ini'
  ]) {
    it(`"${input}"`, () => expect(isAllowedUrl(toUrl(input))).toBe(true))
  }
})

describe('거부 메시지', () => {
  it('AI 가 이해할 수 있는 영문 문자열', () => {
    expect(BLOCKED_URL_MESSAGE).toMatch(/refused/)
  })
})
