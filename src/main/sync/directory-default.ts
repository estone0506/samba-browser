// 앱에 내장된 계정 디렉터리(중앙 프로젝트) 주소 — "로그인 먼저, 설정은 계정에 따라온다"의 로그인 서버.
//
// 여기에는 계정(이메일)과 각자의 데이터 Supabase 주소 두 줄만 저장된다. 주문·금고·북마크 같은 실제 데이터는
// 각자 자기 프로젝트로 간다. anon(publishable) 키는 공개용 키라 저장소에 두어도 되고, 행 수준 보안(RLS)이
// 남의 행을 막는다. service_role 키는 어디에도 없다.
// 빌드 환경변수 SAMBA_DIRECTORY_URL / SAMBA_DIRECTORY_ANON_KEY 가 있으면 그쪽이 우선한다(다른 중앙 프로젝트로 교체용)

export const DEFAULT_DIRECTORY_URL = 'https://tcpxfuagrnbbnzzfvpkf.supabase.co'
export const DEFAULT_DIRECTORY_ANON_KEY = 'sb_publishable_tZE3qhwq5MrLPcinfYYJpQ_siGsEgwy'
