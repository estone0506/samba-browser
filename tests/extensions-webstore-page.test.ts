import { describe, it, expect } from 'vitest'
import {
  WEBSTORE_HOST,
  extractWebstoreId,
  isAddButtonLabel,
  isWebstoreHost
} from '../src/preload/page-webstore'
import { WEBSTORE_HOST as SHARED_WEBSTORE_HOST, isExtensionId } from '../src/shared/extensions'
import { chromeUserAgent } from '../src/main/browser/webstore-ua'

// 웹스토어 탭에서 "Chrome에 추가" 를 가로채는 데 쓰는 순수 판정들.
// DOM 조작은 Electron 안에서만 의미가 있어 여기서는 판정 함수만 본다

describe('웹스토어 호스트 판정', () => {
  it('웹스토어 호스트만 참이다', () => {
    expect(isWebstoreHost('chromewebstore.google.com')).toBe(true)
    expect(isWebstoreHost('CHROMEWEBSTORE.GOOGLE.COM')).toBe(true)
    expect(isWebstoreHost('www.chromewebstore.google.com')).toBe(true)
    expect(isWebstoreHost('chromewebstore.google.com:443')).toBe(true)
  })

  it('비슷하게 생긴 남의 호스트는 거짓이다', () => {
    expect(isWebstoreHost('chromewebstore.google.com.evil.test')).toBe(false)
    expect(isWebstoreHost('evil-chromewebstore.google.com')).toBe(false)
    expect(isWebstoreHost('chrome.google.com')).toBe(false)
    expect(isWebstoreHost('')).toBe(false)
  })

  it('preload 사본과 shared 원본의 호스트 값이 같다', () => {
    expect(WEBSTORE_HOST).toBe(SHARED_WEBSTORE_HOST)
  })
})

describe('경로에서 확장 id 뽑기', () => {
  const id = 'cjpalhdlnbpafiamejdnhcphjbkeiagm'

  it('상세 페이지 경로에서 32자 id 를 찾는다', () => {
    expect(extractWebstoreId(`/detail/ublock-origin/${id}`)).toBe(id)
    expect(extractWebstoreId(`/detail/ublock-origin/${id}/`)).toBe(id)
    // 언어 접두사가 붙은 경로(SPA 이동 포함)
    expect(extractWebstoreId(`/ko/detail/ublock-origin/${id}`)).toBe(id)
  })

  it('상세 페이지가 아니면 null 이다', () => {
    expect(extractWebstoreId('/')).toBeNull()
    expect(extractWebstoreId('/category/extensions')).toBeNull()
    // q~z 는 확장 id 알파벳(a–p)이 아니다
    expect(extractWebstoreId('/detail/x/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull()
    // 31자·33자는 받지 않는다
    expect(extractWebstoreId(`/detail/x/${id.slice(1)}`)).toBeNull()
    expect(extractWebstoreId(`/detail/x/${id}a`)).toBeNull()
  })

  it('뽑아낸 id 는 메인의 id 검사도 통과한다', () => {
    expect(isExtensionId(extractWebstoreId(`/detail/ublock-origin/${id}`))).toBe(true)
    expect(isExtensionId('')).toBe(false)
    expect(isExtensionId(null)).toBe(false)
  })
})

describe('설치 버튼 문구 판정', () => {
  it('한국어·영어 "Chrome에 추가" 를 알아본다', () => {
    expect(isAddButtonLabel('Chrome에 추가')).toBe(true)
    expect(isAddButtonLabel('크롬에 추가')).toBe(true)
    expect(isAddButtonLabel('Add to Chrome')).toBe(true)
    expect(isAddButtonLabel('ADD TO CHROME')).toBe(true)
  })

  it('줄바꿈·연속 공백·NBSP 가 섞여도 같은 문구로 본다', () => {
    expect(isAddButtonLabel('\n  Add to   Chrome \t')).toBe(true)
    expect(isAddButtonLabel('Chrome 에 추가')).toBe(true)
  })

  it('다른 버튼은 잡지 않는다', () => {
    expect(isAddButtonLabel('Added to Chrome')).toBe(false)
    expect(isAddButtonLabel('Chrome에서 삭제')).toBe(false)
    expect(isAddButtonLabel('Remove from Chrome')).toBe(false)
    expect(isAddButtonLabel('')).toBe(false)
    // 페이지 전체 텍스트처럼 문구를 품고만 있는 경우도 아니다(정확히 일치할 때만)
    expect(isAddButtonLabel('무료 Add to Chrome 지금')).toBe(false)
  })
})

describe('웹스토어 전용 크롬 UA', () => {
  const electronUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'samba-browser/1.0.0 Chrome/142.0.0.0 Electron/39.0.0 Safari/537.36'

  it('앱·Electron 제품 토큰을 걷어 낸다', () => {
    expect(chromeUserAgent(electronUa)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/142.0.0.0 Safari/537.36'
    )
  })

  it('이미 순수한 크롬 UA 는 그대로 둔다', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/142.0.0.0 Safari/537.36'
    expect(chromeUserAgent(chrome)).toBe(chrome)
  })

  it('모바일 UA 의 Mobile 토큰은 남긴다', () => {
    const mobile =
      'Mozilla/5.0 (Linux; Android 14; SM-F711N) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/129.0.0.0 Mobile Safari/537.36'
    expect(chromeUserAgent(mobile)).toBe(mobile)
  })

  it('모양이 다른 UA 는 건드리지 않는다', () => {
    expect(chromeUserAgent('weird-agent/1.0')).toBe('weird-agent/1.0')
  })
})
