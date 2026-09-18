import { describe, it, expect } from 'vitest'
import { toUrl } from '../src/main/browser/tab-manager'

describe('toUrl', () => {
  it('http 그대로', () => expect(toUrl('https://a.com/x')).toBe('https://a.com/x'))
  it('도메인은 https 부여', () => expect(toUrl('naver.com')).toBe('https://naver.com'))
  it('검색어는 구글', () => expect(toUrl('삼바웨이브')).toContain('google.com/search?q='))
  // === 검색엔진 설정 (신규 추가분) ==========================================
  it('엔진을 naver 로 주면 네이버 검색', () =>
    expect(toUrl('삼바웨이브', 'naver')).toContain('search.naver.com/search.naver?query='))
  // === 신규 추가분 끝 =========================================================
})
