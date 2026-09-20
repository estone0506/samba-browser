import { describe, it, expect } from 'vitest'
import {
  clampPopupSize,
  extensionPopupUrl,
  normalizeDocumentPath,
  pickActionSection,
  popupBounds,
  POPUP_DEFAULT_HEIGHT,
  POPUP_DEFAULT_WIDTH,
  POPUP_MAX_HEIGHT,
  POPUP_MAX_WIDTH,
  POPUP_MIN_HEIGHT,
  POPUP_MIN_WIDTH,
  resolveActionIconPath,
  resolveOptionsPath,
  resolvePopupPath
} from '../src/main/extensions/action'
import { parseManifest } from '../src/main/extensions/manager'
import type { ExtensionAnchorDto } from '../src/shared/extensions'
import { isExtensionUrl, isAllowedUrl } from '../src/shared/url'
import { isOwnExtensionUrl } from '../src/main/extensions/popup-view'

// SAMBA-WAVE 의 실제 manifest 에서 이 기능이 보는 부분만 옮겨 온 것
const sambaWave = {
  manifest_version: 3,
  name: 'SAMBA-WAVE',
  version: '2.14.101',
  description: '무재고 위탁판매 솔루션',
  permissions: ['cookies', 'storage', 'tabs'],
  host_permissions: ['https://*.musinsa.com/*'],
  action: {
    default_popup: 'popup.html',
    default_icon: { '16': 'icon16.png', '48': 'icon48.png', '128': 'icon128.png' }
  },
  background: { service_worker: 'background.js' },
  icons: { '16': 'icon16.png', '48': 'icon48.png', '128': 'icon128.png' }
}

describe('pickActionSection — 액션 정의를 어디에서 찾는가', () => {
  it('MV3 는 action 을 쓴다', () => {
    expect(pickActionSection({ action: { default_popup: 'a.html' } })).toEqual({
      default_popup: 'a.html'
    })
  })

  it('MV2 는 browser_action 을 쓴다', () => {
    expect(pickActionSection({ browser_action: { default_popup: 'b.html' } })).toEqual({
      default_popup: 'b.html'
    })
  })

  it('page_action 만 있으면 그것을 액션으로 본다', () => {
    expect(pickActionSection({ page_action: { default_popup: 'c.html' } })).toEqual({
      default_popup: 'c.html'
    })
  })

  it('action 이 객체가 아니면(문자열·배열) 없는 것으로 본다', () => {
    expect(pickActionSection({ action: 'popup.html' })).toBeNull()
    expect(pickActionSection({ action: ['popup.html'] })).toBeNull()
    expect(pickActionSection(null)).toBeNull()
  })
})

describe('normalizeDocumentPath — 확장 폴더 안을 가리키는 경로만 받는다', () => {
  it('앞의 슬래시를 떼고 상대 경로로 만든다', () => {
    expect(normalizeDocumentPath('/pages/popup.html')).toBe('pages/popup.html')
  })

  it('역슬래시도 슬래시로 맞춘다(윈도우 확장이 그렇게 적는 경우가 있다)', () => {
    expect(normalizeDocumentPath('pages\\popup.html')).toBe('pages/popup.html')
  })

  it('쿼리·해시는 크롬처럼 그대로 남긴다', () => {
    expect(normalizeDocumentPath('popup.html?tab=1#top')).toBe('popup.html?tab=1#top')
  })

  it('폴더 밖을 노리는 `..` 은 거부한다', () => {
    expect(normalizeDocumentPath('../../secret.html')).toBeNull()
    expect(normalizeDocumentPath('pages/../../secret.html')).toBeNull()
  })

  it('다른 출처를 가리키는 값은 거부한다', () => {
    expect(normalizeDocumentPath('https://evil.test/popup.html')).toBeNull()
    expect(normalizeDocumentPath('//evil.test/popup.html')).toBeNull()
    expect(normalizeDocumentPath('javascript:alert(1)')).toBeNull()
  })

  it('빈 값·문자열이 아닌 값은 없는 것으로 본다', () => {
    expect(normalizeDocumentPath('')).toBeNull()
    expect(normalizeDocumentPath('   ')).toBeNull()
    expect(normalizeDocumentPath('/')).toBeNull()
    expect(normalizeDocumentPath(42)).toBeNull()
    expect(normalizeDocumentPath(undefined)).toBeNull()
  })
})

describe('resolvePopupPath / resolveOptionsPath — 눌렀을 때 무엇을 열까', () => {
  it('SAMBA-WAVE 는 action.default_popup 으로 popup.html 을 연다', () => {
    expect(resolvePopupPath(sambaWave)).toBe('popup.html')
  })

  it('MV2 browser_action 도 같은 자리로 본다', () => {
    expect(resolvePopupPath({ browser_action: { default_popup: 'old.html' } })).toBe('old.html')
  })

  it('팝업이 없으면 null 이다(그때 옵션 페이지로 내려간다)', () => {
    expect(resolvePopupPath({ action: {} })).toBeNull()
    expect(resolvePopupPath({ name: 'x' })).toBeNull()
  })

  it('options_ui.page 가 options_page 보다 우선이다', () => {
    expect(resolveOptionsPath({ options_ui: { page: 'ui.html' }, options_page: 'old.html' })).toBe(
      'ui.html'
    )
  })

  it('options_ui 가 없으면 options_page 를 쓴다', () => {
    expect(resolveOptionsPath({ options_page: 'old.html' })).toBe('old.html')
  })

  it('둘 다 없으면 null 이다', () => {
    expect(resolveOptionsPath(sambaWave)).toBeNull()
  })
})

describe('resolveActionIconPath — 액션 아이콘이 manifest icons 보다 우선', () => {
  it('action.default_icon 의 가장 큰 크기를 고른다', () => {
    expect(resolveActionIconPath(sambaWave)).toBe('icon128.png')
  })

  it('default_icon 이 파일 하나면 그것을 쓴다', () => {
    expect(resolveActionIconPath({ action: { default_icon: 'toolbar.png' } })).toBe('toolbar.png')
  })

  it('액션 아이콘이 없으면 manifest icons 로 내려간다', () => {
    expect(resolveActionIconPath({ action: {}, icons: { '48': 'a.png', '16': 'b.png' } })).toBe(
      'a.png'
    )
  })

  it('둘 다 없으면 null 이다', () => {
    expect(resolveActionIconPath({ name: 'x' })).toBeNull()
  })
})

describe('parseManifest — 액션 정보가 manifest 파싱 결과에 실린다', () => {
  it('SAMBA-WAVE 의 팝업·아이콘을 함께 뽑아낸다', () => {
    const m = parseManifest(sambaWave)
    expect(m.popupPath).toBe('popup.html')
    expect(m.actionIconPath).toBe('icon128.png')
    expect(m.optionsPath).toBeNull()
    expect(m.iconPath).toBe('icon128.png')
  })

  it('액션이 아예 없는 확장도 파싱은 통과한다', () => {
    const m = parseManifest({ name: 'x', version: '1', manifest_version: 3 })
    expect(m.popupPath).toBeNull()
    expect(m.actionIconPath).toBeNull()
  })
})

describe('extensionPopupUrl', () => {
  it('확장 출처 안의 문서 주소를 만든다', () => {
    expect(extensionPopupUrl('ojfcneljbbajgcmpmklgglhenieehicb', 'popup.html')).toBe(
      'chrome-extension://ojfcneljbbajgcmpmklgglhenieehicb/popup.html'
    )
  })

  it('앞에 슬래시가 남아 있어도 두 번 붙지 않는다', () => {
    expect(extensionPopupUrl('abc', '/pages/popup.html')).toBe(
      'chrome-extension://abc/pages/popup.html'
    )
  })

  it('만들어진 주소는 확장 주소로 판정되고, 일반 탐색 관문은 통과하지 못한다', () => {
    const url = extensionPopupUrl('abc', 'popup.html')
    expect(isExtensionUrl(url)).toBe(true)
    // 주소창 입력·웹페이지의 window.open 으로는 열 수 없어야 한다
    expect(isAllowedUrl(url)).toBe(false)
  })
})

describe('clampPopupSize — 크롬과 같은 상한(800×600)에서 자른다', () => {
  it('보통 크기는 그대로 둔다', () => {
    expect(clampPopupSize(300, 420)).toEqual({ width: 300, height: 420 })
  })

  it('상한을 넘으면 800×600 으로 자른다', () => {
    expect(clampPopupSize(1200, 2000)).toEqual({
      width: POPUP_MAX_WIDTH,
      height: POPUP_MAX_HEIGHT
    })
  })

  it('너무 작으면 최소 크기까지 올린다', () => {
    expect(clampPopupSize(10, 5)).toEqual({ width: POPUP_MIN_WIDTH, height: POPUP_MIN_HEIGHT })
  })

  it('소수점은 반올림한다', () => {
    expect(clampPopupSize(300.4, 419.6)).toEqual({ width: 300, height: 420 })
  })

  it('값이 없거나 숫자가 아니면 기본 크기로 되돌린다', () => {
    expect(clampPopupSize(undefined, null)).toEqual({
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT
    })
    expect(clampPopupSize(0, -5)).toEqual({
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT
    })
    expect(clampPopupSize(Number.NaN, '300')).toEqual({
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT
    })
  })
})

describe('popupBounds — 버튼 아래, 오른쪽 맞춤', () => {
  const anchor = (patch: Partial<ExtensionAnchorDto> = {}): ExtensionAnchorDto => ({
    x: 900,
    y: 40,
    width: 28,
    height: 28,
    viewportWidth: 1200,
    viewportHeight: 800,
    ...patch
  })

  it('버튼 오른쪽 끝에 팝업 오른쪽을 맞추고 바로 아래에 둔다', () => {
    const b = popupBounds(anchor(), { width: 300, height: 400 }, 1200, 800)
    // 버튼 오른쪽(928) - 팝업 폭(300)
    expect(b.x).toBe(628)
    // 버튼 아래(68) + 여백(6)
    expect(b.y).toBe(74)
    expect(b).toMatchObject({ width: 300, height: 400 })
  })

  it('창 크기가 렌더러 뷰포트와 다르면 비례해서 다시 투영한다(화면 확대 비율)', () => {
    const b = popupBounds(anchor(), { width: 300, height: 400 }, 2400, 1600)
    // 버튼 오른쪽이 1856 으로 옮겨가고 팝업 크기는 문서 크기 그대로다
    expect(b.x).toBe(1556)
    expect(b.y).toBe(142)
    expect(b).toMatchObject({ width: 300, height: 400 })
  })

  it('왼쪽 끝 버튼이면 창 밖(음수)으로 나가지 않는다', () => {
    const b = popupBounds(anchor({ x: 4 }), { width: 300, height: 400 }, 1200, 800)
    expect(b.x).toBe(0)
  })

  it('아래로 넘칠 만큼 크면 창 안으로 밀어 올린다', () => {
    const b = popupBounds(anchor(), { width: 300, height: 600 }, 1200, 400)
    expect(b.y).toBe(0)
    // 창보다 큰 팝업은 창 크기까지 줄인다
    expect(b.height).toBe(400)
  })

  it('뷰포트 정보가 없으면(0) 좌표를 그대로 쓴다', () => {
    const b = popupBounds(
      anchor({ viewportWidth: 0, viewportHeight: 0 }),
      { width: 300, height: 400 },
      1200,
      800
    )
    expect(b.x).toBe(628)
    expect(b.y).toBe(74)
  })
})

// I4 — 확장 팝업은 그 확장의 문서 밖으로 나가지 못한다
describe('isOwnExtensionUrl — 팝업이 머물러도 되는 주소', () => {
  const ID = 'abcdefghijklmnopabcdefghijklmnop'

  it('같은 확장의 문서면 허용한다', () => {
    expect(isOwnExtensionUrl(`chrome-extension://${ID}/popup.html`, ID)).toBe(true)
    expect(isOwnExtensionUrl(`chrome-extension://${ID}/sub/page.html?q=1`, ID)).toBe(true)
  })

  it('다른 확장·웹·파일 주소는 막는다', () => {
    expect(
      isOwnExtensionUrl('chrome-extension://otherotherotherotherotherother11/p.html', ID)
    ).toBe(false)
    expect(isOwnExtensionUrl('https://example.com/', ID)).toBe(false)
    expect(isOwnExtensionUrl('file:///C:/Users/me/vault.db', ID)).toBe(false)
    expect(isOwnExtensionUrl('javascript:alert(1)', ID)).toBe(false)
    expect(isOwnExtensionUrl('주소가 아님', ID)).toBe(false)
  })
})
