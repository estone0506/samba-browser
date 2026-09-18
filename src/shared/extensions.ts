// 확장(압축 해제된 크롬 확장 폴더) 공유 타입. 메인·프리로드·렌더러가 함께 쓴다.
// 여기에는 비밀값이 들어가지 않는다 — 폴더 경로와 manifest 의 이름·버전뿐이다

/** 설정 화면 목록의 확장 한 줄 */
export interface ExtensionDto {
  id: string
  name: string
  version: string
  path: string
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
