import { describe, it, expect } from 'vitest'
import { toUrl } from '../src/main/browser/tab-manager'

describe('toUrl', () => {
  it('http 그대로', () => expect(toUrl('https://a.com/x')).toBe('https://a.com/x'))
  it('도메인은 https 부여', () => expect(toUrl('naver.com')).toBe('https://naver.com'))
  it('검색어는 구글', () => expect(toUrl('삼바웨이브')).toContain('google.com/search?q='))
})
