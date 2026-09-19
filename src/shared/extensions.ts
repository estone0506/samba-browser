// 확장(압축 해제된 크롬 확장 폴더) 공유 타입. 메인·프리로드·렌더러가 함께 쓴다.
// 여기에는 비밀값이 들어가지 않는다 — 폴더 경로와 manifest 의 이름·버전뿐이다

/** 확장이 어디에서 왔는지 — 목록 행에 출처로 보여 준다 */
export type ExtensionSource = 'store' | 'imported' | 'folder'

export const EXTENSION_SOURCES = ['store', 'imported', 'folder'] as const

/** 설정 화면 목록의 확장 한 줄 */
export interface ExtensionDto {
  id: string
  name: string
  version: string
  path: string
  /** 어디에서 온 확장인지(설정에 기록이 없으면 'folder' 로 본다) */
  source: ExtensionSource
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
