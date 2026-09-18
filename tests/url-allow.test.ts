import { describe, it, expect } from 'vitest'
import {
  isAllowedUrl,
  isHttpUrl,
  isInternalUrl,
  isAllowedExternalUrl,
  BLOCKED_URL_MESSAGE,
  NEW_TAB_URL
} from '../src/shared/url'
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

describe('내부 페이지(samba://newtab)', () => {
  it('새 탭 페이지는 사용자 탐색 관문을 통과한다', () => {
    expect(isAllowedUrl(NEW_TAB_URL)).toBe(true)
    expect(isAllowedUrl('SAMBA://NEWTAB')).toBe(true)
    expect(isAllowedUrl('samba://newtab/')).toBe(true)
  })
  it('허용 목록에 없는 samba: 주소는 거부', () => {
    expect(isAllowedUrl('samba://settings')).toBe(false)
    expect(isAllowedUrl('samba://newtab/../../etc')).toBe(false)
    expect(isInternalUrl('samba://newtabx')).toBe(false)
  })
  it('내부 페이지는 외부용 관문(AI 도구·북마크 저장)에서는 거부', () => {
    expect(isAllowedExternalUrl(NEW_TAB_URL)).toBe(false)
    expect(isAllowedExternalUrl('https://a.com')).toBe(true)
    expect(isAllowedExternalUrl('about:blank')).toBe(true)
    expect(isAllowedExternalUrl('file:///a')).toBe(false)
  })
  it('내부 페이지는 외부 브라우저로 열 대상이 아니다', () => {
    expect(isHttpUrl(NEW_TAB_URL)).toBe(false)
  })
  it('주소창에 samba://newtab 을 치면 그대로 연다(크롬의 chrome://newtab 과 같은 방식)', () => {
    expect(toUrl(NEW_TAB_URL)).toBe(NEW_TAB_URL)
    expect(isInternalUrl(toUrl(NEW_TAB_URL))).toBe(true)
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
