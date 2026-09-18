// 동기화 백엔드 인터페이스 — 테스트 경계. 여기 위로는 supabase-js 를 모른다.
// 테스트는 tests/stubs/fake-backend.ts 의 가짜 구현만 쓴다(네트워크 없음)

/** 원격 테이블의 한 행. 컬럼 구성은 테이블마다 다르므로 열린 형태로 둔다 */
export interface RemoteRow {
  id: string
  [column: string]: unknown
}

export interface SyncBackend {
  signUp(email: string, password: string): Promise<{ userId: string; email: string }>
  signIn(email: string, password: string): Promise<{ userId: string; email: string }>
  /** 구글 로그인용 주소를 만든다(브라우저는 호출부가 연다) */
  oauthUrl(redirectTo: string): Promise<string>
  /** 딥링크로 돌아온 인증 코드를 세션으로 바꾼다 */
  exchangeCode(code: string): Promise<{ userId: string; email: string }>
  signOut(): Promise<void>
  currentUser(): Promise<{ userId: string; email: string } | null>
  /** updated_at 이 sinceMs 보다 큰 행만 오래된 순으로 준다 */
  select(table: string, sinceMs: number): Promise<RemoteRow[]>
  upsert(table: string, rows: RemoteRow[]): Promise<void>
  remove(table: string, ids: string[]): Promise<void>
  /** 변경 알림 구독. 반환값을 호출하면 구독을 푼다 */
  subscribe(table: string, onChange: () => void): Promise<() => void>
}

/** 토큰 만료·기기 원격 로그아웃 — 호출부는 이 에러를 받으면 로그아웃하고 금고를 잠근다 */
export class AuthExpiredError extends Error {}
