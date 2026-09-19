// 확장(압축 해제된 크롬 확장 폴더) 공유 타입. 메인·프리로드·렌더러가 함께 쓴다.
// 여기에는 비밀값이 들어가지 않는다 — 폴더 경로와 manifest 의 이름·버전뿐이다

/** 확장이 어디에서 왔는지 — 목록 행에 출처로 보여 준다 */
export type ExtensionSource = 'store' | 'imported' | 'folder'

export const EXTENSION_SOURCES = ['store', 'imported', 'folder'] as const

/** 확장 프로그램 화면 카드 한 장 */
export interface ExtensionDto {
  id: string
  name: string
  version: string
  path: string
  /** 어디에서 온 확장인지(설정에 기록이 없으면 'folder' 로 본다) */
  source: ExtensionSource
  /** manifest 의 설명(없으면 빈 문자열) */
  description: string
  /** manifest 가 요청하는 권한 — 세부정보에 요약으로 보여 준다 */
  permissions: string[]
  /** 꺼 두면 목록에는 남지만 세션에서는 걷어낸다 */
  enabled: boolean
  /**
   * 툴바에 그릴 아이콘. data:image/... 형태.
   * action.default_icon 이 있으면 그것을, 없으면 manifest icons 중 가장 큰 것을 쓴다.
   * 둘 다 없으면 화면에서 기본 퍼즐 아이콘으로 대신한다
   */
  icon?: string
  /**
   * 아이콘을 눌렀을 때 띄울 팝업 문서의 확장 안 상대 경로.
   * MV3 는 action.default_popup, MV2 는 browser_action/page_action.default_popup 이다
   */
  popup?: string
  /** 팝업이 없는 확장을 눌렀을 때 새 탭으로 여는 옵션 페이지(options_ui.page 또는 options_page) */
  optionsPage?: string
}

/**
 * 툴바 아이콘을 눌렀을 때 실제로 벌어진 일.
 * - popup: 팝업 문서를 띄웠거나(open=true) 이미 떠 있어 닫았다(open=false)
 * - options: 옵션 페이지를 새 탭으로 열었다
 * - none: 팝업도 옵션 페이지도 없어 아무 일도 하지 않았다
 *   (크롬이라면 chrome.action.onClicked 가 불릴 자리인데 Electron 이 지원하지 않는다)
 */
export type ExtensionActionKind = 'popup' | 'options' | 'none'

export interface ExtensionActionResult {
  kind: ExtensionActionKind
  /** 팝업이 지금 떠 있는지(kind 가 popup 일 때만 의미가 있다) */
  open: boolean
}

/**
 * 툴바 버튼의 위치 — 팝업을 그 아래에 붙이기 위해 렌더러가 보고한다.
 * 좌표는 렌더러 CSS 픽셀이고, 메인이 창 콘텐츠 크기에 다시 투영한다
 * (화면 확대 비율이 100%가 아니어도 어긋나지 않게 측정 기준 뷰포트를 함께 보낸다)
 */
export interface ExtensionAnchorDto {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

/** 로드 실패 한 건. 앱을 멈추지 않고 화면에 표시만 한다 */
export interface ExtensionError {
  path: string
  error: string
}

/** ext:list 응답 — 목록과 실패 사유를 함께 돌려준다 */
export interface ExtensionListDto {
  items: ExtensionDto[]
  errors: ExtensionError[]
}

/** 다른 브라우저에 설치된 확장 한 개(가져오기 후보) */
export interface ImportExtensionDto {
  id: string
  name: string
  version: string
  /** 원본 폴더(<id>/<version>) — 여기서 앱 데이터로 복사한다 */
  path: string
  /** 어느 브라우저에서 왔는지(chrome | whale | edge | brave) */
  browser: string
  /** data:image/... 형태. 아이콘을 못 읽으면 없다 */
  icon?: string
}

/** 가져올 수 있는 브라우저 한 종류와 그 안에서 찾은 확장들 */
export interface ImportBrowserDto {
  key: string
  /** 사람이 읽는 브라우저 이름 */
  name: string
  items: ImportExtensionDto[]
}

/** 가져오기·웹스토어 설치 결과 한 건. 실패해도 나머지는 계속 진행한다 */
export interface ExtensionInstallResult {
  id: string
  /** 성공했을 때의 확장 정보 */
  item?: ExtensionDto
  /** 실패 사유(성공이면 없다) */
  error?: string
}

// === 크롬 웹스토어에서 바로 설치 =============================================
// 확장 설치는 크롬과 똑같이 웹스토어 탭에서 "Chrome에 추가" 를 눌러 이뤄진다.
// page preload 는 shared 의 값을 import 할 수 없어 같은 값을 복제해 두고
// (src/preload/page-webstore.ts 의 WEBSTORE_HOST), preload-bundle 테스트가 대조한다

/** 크롬 웹스토어 호스트 — 설치 요청은 이 호스트의 탭에서만 받는다 */
export const WEBSTORE_HOST = 'chromewebstore.google.com'

/** '확장 설치' 버튼이 새 탭으로 여는 주소 */
export const WEBSTORE_URL = 'https://chromewebstore.google.com/'

/** 확장 id 는 a–p 32자다(크로미움이 공개키 해시를 그렇게 인코딩한다) */
const EXTENSION_ID_RE = /^[a-p]{32}$/

/** 확장 id 형태인가 */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_ID_RE.test(value)
}
