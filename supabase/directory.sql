-- 계정 디렉터리(중앙 프로젝트) 전용 추가분. 먼저 schema.sql 을 적용한 뒤 이 파일을 적용한다.
-- 몇 번을 다시 실행해도 안전하다.
--
-- 디렉터리는 사용자마다 settings_sync 표의 고정 작업공간(nil uuid) 한 칸에
-- "내 데이터 Supabase 주소" 두 줄(directory.supabaseUrl / directory.supabaseAnonKey)만 둔다.
-- RLS(user_id = auth.uid())가 이미 걸려 있어 남의 행은 보이지 않는다.

-- 관리자에게만 가입 사용자 수를 돌려주는 함수. 앱은 있으면 보여 주고 없으면(null) 숨긴다.
-- 관리자 이메일은 여기(서버)에만 두고 앱 코드에는 넣지 않는다.
create or replace function public.directory_user_count()
returns integer
language sql
security definer
set search_path = public
as $$
  select case
    when (auth.jwt() ->> 'email') = 'buyer02@naver.com'
      then (select count(*)::integer from auth.users)
    else null
  end;
$$;

revoke all on function public.directory_user_count() from public;
grant execute on function public.directory_user_count() to authenticated;
