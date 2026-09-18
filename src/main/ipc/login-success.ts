// 로그인 폼 제출 뒤 URL 변화 · 페이지 텍스트로 "로그인 성공"을 추정하는 순수 함수.
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.
//
// 판정 기준(스펙):
// - 새 URL 이 제출 시점 URL 과 달라야 한다(같으면 아직 같은 페이지에 머무는 것)
// - 새 URL 이 로그인 페이지 경로(login|signin|auth|nid 포함)를 벗어나야 한다
// - 새 페이지 텍스트 앞 3000자에 실패를 뜻하는 문구(비밀번호가 일치/틀렸/incorrect/invalid/잘못)가 없어야 한다
// 셋 중 하나라도 어긋나면 실패로 간주해 자동 갱신을 하지 않는다(보수적 판정).

const LOGIN_PATH_RE = /login|signin|auth|nid/i
const FAILURE_TEXT_RE = /비밀번호가\s*일치|틀렸|incorrect|invalid|잘못/i

// 실패 문구 검사에 쓰는 텍스트 앞부분 길이. 너무 긴 페이지 텍스트를 전부 정규식에 태우지 않기 위함
export const SNAPSHOT_TEXT_CHECK_LIMIT = 3000

export function isLoginSuccess(prevUrl: string, newUrl: string, text: string): boolean {
  if (!prevUrl || !newUrl) return false
  if (newUrl === prevUrl) return false
  if (LOGIN_PATH_RE.test(newUrl)) return false
  const snippet = text.slice(0, SNAPSHOT_TEXT_CHECK_LIMIT)
  if (FAILURE_TEXT_RE.test(snippet)) return false
  return true
}
