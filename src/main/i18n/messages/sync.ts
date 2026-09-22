// 동기화·로그인 문구
import { defineMessages } from '../define'

export const syncMessages = defineMessages({
  ko: {
    'auth.badSupabaseUrl': 'https:// 로 시작하는 프로젝트 URL 을 넣어 주세요',
    'auth.badSupabaseKey': 'anon(publishable) 키만 넣을 수 있습니다. service_role 키는 넣지 마세요',
    'auth.notConfigured':
      'Supabase 설정이 필요합니다. docs/supabase-설정.md 를 보고 .env 를 채워 주세요',
    'auth.emailRequired': '이메일을 입력해 주세요',
    'auth.passwordRequired': '비밀번호를 입력해 주세요',
    'auth.notGoogleCallback': '구글 로그인 콜백 주소가 아닙니다',
    'auth.googleStateMismatch': '구글 로그인 state 값이 일치하지 않습니다',
    'auth.googleFailed': '구글 로그인 실패: {reason}',
    'auth.googlePortUnavailable': '구글 로그인에 쓸 포트를 열지 못했습니다',
    'auth.googleTimeout': '구글 로그인 시간이 초과되었습니다',
    'auth.googleCancelled': '구글 로그인이 취소되었습니다',
    'auth.googleUrlMissing': '구글 로그인 주소를 받지 못했습니다',
    'auth.userMissing': '사용자 정보를 받지 못했습니다',
    'auth.callbackTitleOk': '로그인 완료',
    'auth.callbackTitleFail': '로그인 실패',
    'auth.callbackBodyOk': '이 창을 닫아도 됩니다. SAMBA Browser 로 돌아가세요.',
    'auth.callbackBodyFail': '로그인을 마치지 못했습니다. 이 창을 닫고 앱에서 다시 시도하세요.',
    'sync.deviceLoggedOutRemotely': '이 기기는 다른 기기에서 로그아웃되었습니다',
    'sync.deviceRevoked': '이 기기는 다른 기기에서 로그아웃됐어요',
    'sync.deviceNotFound': '기기를 찾을 수 없습니다',
    'sync.unnamedDevice': '이름 없는 기기'
  },
  en: {
    'auth.badSupabaseUrl': 'Enter a project URL starting with https://',
    'auth.badSupabaseKey':
      'Only the anon (publishable) key is accepted. Never paste the service_role key',
    'auth.notConfigured':
      'Supabase is not configured. Fill in .env following docs/supabase-설정.md',
    'auth.emailRequired': 'Please enter your email',
    'auth.passwordRequired': 'Please enter your password',
    'auth.notGoogleCallback': 'Not a Google sign-in callback URL',
    'auth.googleStateMismatch': 'Google sign-in state value does not match',
    'auth.googleFailed': 'Google sign-in failed: {reason}',
    'auth.googlePortUnavailable': 'Could not open a port for Google sign-in',
    'auth.googleTimeout': 'Google sign-in timed out',
    'auth.googleCancelled': 'Google sign-in was cancelled',
    'auth.googleUrlMissing': 'Did not receive the Google sign-in URL',
    'auth.userMissing': 'Did not receive user information',
    'auth.callbackTitleOk': 'Signed in',
    'auth.callbackTitleFail': 'Sign-in failed',
    'auth.callbackBodyOk': 'You can close this window and return to SAMBA Browser.',
    'auth.callbackBodyFail':
      'Sign-in did not complete. You can close this window and try again in the app.',
    'sync.deviceLoggedOutRemotely': 'This device was signed out from another device',
    'sync.deviceRevoked': 'This device was signed out from another device',
    'sync.deviceNotFound': 'Device not found',
    'sync.unnamedDevice': 'Unnamed device'
  }
})
