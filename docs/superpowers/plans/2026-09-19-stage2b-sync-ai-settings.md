# 2b단계 구현 계획: Supabase 동기화 + 계정/기기 + 작업공간 + AI 연결 + 설정 화면

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 계정으로 여러 PC에서 설정·계정·금고(암호문)·북마크를 공유하고, AI 연결 경로(Claude 구독 / 내 API 키 / 서비스 크레딧 자리)와 작업별 모델을 사용자가 직접 고를 수 있게 한다. 2단계에서 로컬에만 있던 것들에 계정·동기화·설정 껍데기를 씌운다.

**Architecture:** 로컬 sql.js+drizzle DB 가 단일 진실 원천(source of truth)이고, `src/main/sync/` 어댑터가 변경 로그(`sync_outbox`) 기반으로 Supabase(PostgreSQL + Auth + RLS)에 푸시/풀 한다. 금고는 **암호문만** 올라가며 마스터 키는 기기 밖으로 나가지 않는다. 충돌은 LWW(설정·계정·금고) / 합집합(북마크) / tombstone(삭제) 규칙의 **순수 함수**(`merge.ts`)로 해결한다. Supabase 접근은 `SyncBackend` 인터페이스 뒤에 숨겨 테스트는 네트워크 없이 가짜 백엔드로 돌린다. AI 연결은 `src/main/ai/`(제공자 감지·키 보관·작업별 모델)가 담당하고 `agent/runner.ts` 가 소비한다.

**Tech Stack:** 2단계 스택(Electron 39 · React 19 · TypeScript · sql.js · drizzle-orm · hash-wasm · zod · zustand · i18next · Tailwind) + `@supabase/supabase-js`

---

## Global Constraints

2단계 계획의 Global Constraints 를 전부 유지하고, 아래를 추가한다.

**코드 스타일 / 공통**
- 세미콜론 없음 · 작은따옴표 · 들여쓰기 2칸 · `any` 타입 금지 · 주석과 커밋 메시지는 한국어
- 모든 사용자 노출 문자열은 `t()` 경유, i18n `ko`/`en` 두 파일(`src/renderer/src/i18n/{ko,en}.json`)을 항상 함께 갱신
- UI 는 애플 풍(흰 카드 `rounded-2xl border border-[var(--line)] bg-white`, 얇은 선, 검정 기본 버튼, 브랜드 컬러 없음) — `SettingsPage.tsx` 의 `SettingsSection`/`SettingsRow`/`SegmentedGroup` 을 재사용
- IPC 응답 형식은 기존 `IpcResult<T>` = `{ok:true,data}|{ok:false,error}` 유지
- **새 렌더러 채널은 예외 없이 `handleFromRenderer`(invoke) 또는 `onFromRenderer`(send) 로 등록**한다. `ipcMain.handle` 직접 호출은 페이지(격리 월드)가 쓰는 채널 전용이며, 그 경우 전용 게이트(발신자가 관리 중인 탭인지 + frameUrl 검증)를 반드시 둔다
- **페이지 프리로드(`src/preload/page*.ts`)는 `src/shared/*` 의 값(value)을 import 하지 않는다.** 필요한 상수는 `src/preload/page-constants.ts` 에 사본을 두고 `tests/preload-bundle.test.ts` 로 동기화를 강제한다. `src/preload/renderer.ts` 는 기존대로 `IPC` 값 import 가능
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- 브랜치: `feature/stage2b-sync` (main 직접 커밋 금지)

**동기화 안전장치 (스펙 "핵심 결정"·"안전장치" 의 정확한 값)**
- **금고는 암호문만 업로드한다.** `vault_items_sync` 에 올라가는 것은 `fields_ciphertext`(bytea) · `iv`(bytea) · `aad`(text) · `label`(평문 허용, 사용자 지정 이름) · `type` · `account_id` · `workspace_id` · `updated_at` · `deleted_at` 뿐이다
- **전송 직전 런타임 검사**: `assertNoPlaintext(payload)` 가 허용 키 화이트리스트 밖의 키 또는 `value`/`password`/`secret` 문자열 키를 발견하면 **전송을 중단하고 에러 로그**를 남긴다(테스트로 단언)
- **복구 키는 24자 base32(Crockford, `ILOU` 제외) · 4자씩 6그룹**(`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, 120비트). 생성 화면에서만 표시되고 DB·로그에 평문으로 남지 않으며, **재입력 확인에 성공해야만** 다음 단계로 넘어간다. 마스터 비밀번호와 복구 키를 둘 다 잃으면 복구 불가임을 화면에 고정 노출
- **충돌 규칙**: 설정·계정·금고 = LWW(`updatedAt` 큰 쪽), 북마크 = 합집합(같은 `folderPath` + `url` 은 1개), 감사 로그 = 동기화 안 함
- **삭제는 tombstone**: 행을 지우지 않고 `deletedAt` 을 설정해 동기화하고, **30일**(`TOMBSTONE_TTL_DAYS = 30`) 뒤 물리 삭제
- **폴링 주기 60초**(`SYNC_POLL_INTERVAL_MS = 60_000`). 앱 시작 시 1회 풀 + 이후 60초 주기 + Realtime 구독은 "가능할 때만"(실패해도 폴링으로 동작)
- **API 키·refresh token 은 렌더러로 절대 전달하지 않는다.** 렌더러에는 마스킹 문자열(`sk-ant-••••4자리`)과 boolean 만 간다
- **Supabase 서비스 롤 키는 앱에 포함 금지.** 앱은 anon 키 + 사용자 JWT 로만 접근한다. `.env`/코드/로그 어디에도 서비스 롤 키를 두지 않는다
- **감사 로그(`audit_log`)는 Supabase 에 테이블을 만들지 않는다.** 동기화 대상 테이블 목록(`SYNC_TABLES`)에 존재하지 않아야 하며 테스트로 단언
- 로그아웃 시 로컬 DB 는 유지하되 금고는 즉시 잠금, `sync_outbox` 는 보존(재로그인 시 전송)
- 기기 원격 로그아웃 후 해당 PC 는 다음 동기화에서 401 → 자동 로그아웃 + 금고 잠금
- Supabase URL·anon 키는 `.env` 의 `SAMBA_SUPABASE_URL` / `SAMBA_SUPABASE_ANON_KEY` 로 주입한다. **`.env` 는 커밋 금지**(`.gitignore`), `.env.example` 만 커밋
- 테스트는 네트워크를 쓰지 않는다. `SyncBackend` 인터페이스의 가짜 구현(`tests/stubs/fake-backend.ts`)으로만 검증한다

---

## 파일 구조

```
supabase/
  schema.sql              테이블 + RLS 정책(사용자가 대시보드 SQL 편집기에 붙여넣음)
docs/
  supabase-설정.md         비개발자용 프로젝트 생성·구글 OAuth·.env 작성 안내
.env.example              SAMBA_SUPABASE_URL / SAMBA_SUPABASE_ANON_KEY

src/shared/
  sync.ts                 SyncStatus, AuthState, DeviceDto, WorkspaceDto, SYNC_TABLES
  ai.ts                   AiProviderId, AiProviderStatus, TaskModelKey, TaskModels
  settings.ts             (수정) 동기화·AI·에이전트·작업공간 설정 추가
  ipc.ts                  (수정) auth:* sync:* devices:* workspace:* ai:* vault:recovery* vault:export ext:*

src/main/db/
  schema.ts               (수정) workspaces, syncOutbox, syncState + 기존 표 컬럼 추가
  migrations.ts           (수정) 0005 추가

src/main/sync/
  env.ts                  SAMBA_SUPABASE_* 읽기(process.env → import.meta.env 순)
  backend.ts              SyncBackend 인터페이스(테스트 경계)
  supabase-backend.ts     supabase-js 구현 + safeStorage 세션 저장소
  session-store.ts        refresh token 을 safeStorage 로 감싸 파일로 보관
  auth.ts                 AuthService: 가입·로그인·구글 OAuth·로그아웃·상태
  oauth.ts                samba://auth 딥링크 파싱(순수 함수)
  merge.ts                LWW·합집합·tombstone 순수 함수
  guard.ts                assertNoPlaintext 런타임 검사
  outbox.ts               변경 로그 기록·조회·재시도 표시
  mappers.ts              로컬 행 ↔ 원격 행 변환(테이블별)
  push.ts                 outbox → 원격
  pull.ts                 원격 → 로컬(merge 적용)
  engine.ts               SyncEngine: 시작/정지·60초 폴링·Realtime·상태 통지
  devices.ts              기기 등록·목록·원격 로그아웃

src/main/vault/
  recovery.ts             복구 키 생성(24자)·정규화·검증·래핑/언래핑
  export.ts               CSV/JSON 내보내기(잠금 해제 + 마스터 재입력 필수)

src/main/workspace/
  service.ts              작업공간 CRUD·전환·범위 필터

src/main/ai/
  providers.ts            Claude 구독 감지 · 제공자 상태
  keys.ts                 safeStorage 로 API 키 보관(동기화 안 함, 렌더러 미전달)
  models.ts               작업별 모델(Fast/Standard/Deep/Visual) 매핑·자동 대체

src/main/extensions/
  manager.ts              압축 해제된 크롬 확장 폴더 로드·목록·제거

src/renderer/src/
  stores/{authStore,syncStore,workspaceStore,aiStore}.ts
  pages/SettingsPage.tsx                     (재작성: 좌측 섹션 목록 + 우측 패널)
  components/settings/{GeneralSection,AppearanceSection,AccountSection,SecuritySection,
                       AgentSection,AiSection,KeymasterSection,PlaceholderSection}.tsx
  components/settings/{DeviceList,RecoveryKeyDialog,ExportDialog}.tsx
  components/ai/{ProviderCard,TaskModelTable}.tsx
  components/workspace/WorkspaceSwitcher.tsx

tests/
  sync-env.test.ts  sync-merge.test.ts  sync-guard.test.ts  sync-outbox.test.ts
  sync-push.test.ts  sync-pull.test.ts  sync-engine.test.ts  sync-auth.test.ts
  sync-oauth.test.ts  sync-devices.test.ts  vault-recovery.test.ts
  workspace-service.test.ts  ai-providers.test.ts  ai-keys.test.ts  ai-models.test.ts
  vault-export.test.ts  extensions-manager.test.ts
  stubs/fake-backend.ts
```

---

### Task 1: Supabase 스키마 SQL + RLS + 비개발자용 설정 문서

사용자가 **직접 Supabase 대시보드에서 프로젝트를 만들고** URL·anon 키를 `.env` 로 넘겨주는 것을 전제로 한다. 이 Task 는 코드가 아니라 "사용자가 따라 하면 되는 산출물"을 만든다.

**Files:** Create `supabase/schema.sql`, `docs/supabase-설정.md`, `.env.example`, `src/main/sync/env.ts`; Modify `.gitignore`, `electron.vite.config.ts`, `package.json`; Test `tests/sync-env.test.ts`

**Interfaces:** `readSupabaseEnv(): { url: string; anonKey: string }`, `hasSupabaseEnv(): boolean`

- [ ] Step 1: 의존성 설치 — `pnpm add @supabase/supabase-js`
- [ ] Step 2: `supabase/schema.sql` 작성(사용자가 SQL 편집기에 통째로 붙여넣는 파일). `audit` 테이블은 **없다**.
```sql
-- SAMBA Browser 2b단계 스키마. Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run.
-- 몇 번을 다시 실행해도 안전하다(create if not exists / drop policy if exists).

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  os text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.settings_sync (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, workspace_id, key)
);

create table if not exists public.accounts_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  host text not null,
  label text not null,
  username text not null,
  is_default boolean not null default false,
  urls jsonb not null default '[]'::jsonb,
  agent_access text not null default 'inherit',
  tags jsonb not null default '[]'::jsonb,
  paused_until timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 평문 비밀값 컬럼은 존재하지 않는다. label 만 사용자 지정 이름이라 평문이다.
create table if not exists public.vault_items_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  account_id uuid,
  type text not null,
  label text not null,
  fields_ciphertext bytea not null,
  iv bytea not null,
  aad text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.bookmarks_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  folder_path text not null default '',
  title text not null,
  url text not null,
  position integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 4단계(자동화 레시피)용 자리. 2b 에서는 읽지도 쓰지도 않는다.
create table if not exists public.recipes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  name text not null,
  prompt text,
  rules jsonb not null default '{}'::jsonb,
  procedure jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists accounts_sync_pull_idx on public.accounts_sync (user_id, updated_at);
create index if not exists vault_items_sync_pull_idx on public.vault_items_sync (user_id, updated_at);
create index if not exists bookmarks_sync_pull_idx on public.bookmarks_sync (user_id, updated_at);
create index if not exists settings_sync_pull_idx on public.settings_sync (user_id, updated_at);
create index if not exists workspaces_pull_idx on public.workspaces (user_id, updated_at);

-- === 행 수준 보안 ========================================================
alter table public.profiles        enable row level security;
alter table public.workspaces      enable row level security;
alter table public.devices         enable row level security;
alter table public.settings_sync   enable row level security;
alter table public.accounts_sync   enable row level security;
alter table public.vault_items_sync enable row level security;
alter table public.bookmarks_sync  enable row level security;
alter table public.recipes         enable row level security;

-- profiles 는 자기 자신(id = auth.uid())만
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete on public.profiles for delete to authenticated using (id = auth.uid());

-- 나머지 테이블은 전부 user_id = auth.uid() 4종 정책
do $$
declare t text;
begin
  foreach t in array array['workspaces','devices','settings_sync','accounts_sync','vault_items_sync','bookmarks_sync','recipes']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = auth.uid())', t || '_delete', t);
  end loop;
end $$;

-- anon 롤에는 어떤 권한도 주지 않는다(정책이 authenticated 전용이라 anon 은 0행을 본다).
revoke all on all tables in schema public from anon;

-- 가입 즉시 profiles 행을 만든다
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```
- [ ] Step 3: `docs/supabase-설정.md` — 비개발자용 단계별 안내. 아래 목차와 내용을 그대로 쓴다(스크린샷 없이 글자만으로 따라갈 수 있게, 각 단계 끝에 "이렇게 보이면 성공" 문장 포함).
  1. **가입** — supabase.com → Start your project → GitHub 또는 이메일로 가입
  2. **프로젝트 만들기** — New project → Name `samba-browser`, Database Password 는 **길게 만들어 비밀번호 관리자에 저장**(분실해도 앱 동작에는 지장 없음), Region `Northeast Asia (Seoul)` → Create. 2~3분 기다리면 초록색 Active 표시
  3. **표 만들기** — 왼쪽 메뉴 SQL Editor → New query → 저장소의 `supabase/schema.sql` 내용을 전부 복사해 붙여넣기 → Run. 아래에 `Success. No rows returned` 가 나오면 성공
  4. **확인** — Table Editor 에서 `profiles`, `accounts_sync`, `vault_items_sync` 등 8개 표가 보이고, 표 이름 옆에 자물쇠(RLS enabled) 표시가 있으면 성공. **`audit` 이라는 표는 없어야 정상**이다
  5. **이메일 로그인 켜기** — Authentication → Providers → Email 이 Enabled 인지 확인. 테스트 편의를 위해 Authentication → Settings 에서 "Confirm email" 을 잠시 꺼도 된다(배포 시 다시 켤 것)
  6. **구글 로그인 켜기** — Google Cloud Console → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션) 만들기 → 승인된 리디렉션 URI 에 Supabase 가 알려주는 `https://<프로젝트ref>.supabase.co/auth/v1/callback` 을 넣고, 발급된 Client ID/Secret 을 Supabase 의 Authentication → Providers → Google 에 붙여넣고 Enable
  7. **앱이 돌아올 주소 등록** — Authentication → URL Configuration → Redirect URLs 에 `samba://auth` 를 **추가**하고 저장. 이게 없으면 구글 로그인 후 앱으로 돌아오지 못한다
  8. **키 복사** — Project Settings → API → `Project URL` 과 `anon public` 키를 복사. **`service_role` 키는 절대 복사하지 않는다**(이 키는 모든 데이터를 읽을 수 있어 앱에 넣으면 안 된다)
  9. **.env 작성** — 저장소 루트의 `.env.example` 을 `.env` 로 복사하고 두 값을 채운다. `.env` 는 깃에 올라가지 않는다
  10. **동작 확인** — `pnpm dev` → 설정 → 계정 → 가입/로그인. "동기화: 연결됨" 이 보이면 끝
  11. **문제 해결** — (a) `Invalid API key` → URL/anon 키 오타 (b) 구글 로그인 후 아무 일도 없음 → 7번 Redirect URLs 누락 (c) 표는 있는데 0행만 보임 → RLS 정상 동작(다른 계정의 데이터가 안 보이는 것) (d) `.env` 를 고쳤는데 그대로 → `pnpm dev` 재시작 필요
- [ ] Step 4: `.env.example` 생성 + `.gitignore` 에 `.env` 추가
```
# Supabase 프로젝트 설정(docs/supabase-설정.md 8번 참고)
# service_role 키는 절대 넣지 않는다
SAMBA_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SAMBA_SUPABASE_ANON_KEY=eyJhbGciOi...
```
- [ ] Step 5: `electron.vite.config.ts` 의 최상위(또는 `main` 섹션)에 `envPrefix: ['MAIN_VITE_', 'SAMBA_']` 를 추가해 `SAMBA_*` 가 메인 번들에 주입되게 한다.
- [ ] Step 6: 실패 테스트 `tests/sync-env.test.ts` — `process.env.SAMBA_SUPABASE_URL` 설정 시 그 값을 읽음 / 미설정 시 빈 문자열 + `hasSupabaseEnv() === false` / 값이 있으면 `true`.
- [ ] Step 7: `src/main/sync/env.ts` 구현
```ts
// Supabase 접속 정보 읽기. 개발(process.env)·빌드(import.meta.env) 양쪽을 지원한다.
// 서비스 롤 키는 읽지 않는다 — 앱에는 anon 키만 들어간다

export interface SupabaseEnv {
  url: string
  anonKey: string
}

const URL_KEY = 'SAMBA_SUPABASE_URL'
const ANON_KEY = 'SAMBA_SUPABASE_ANON_KEY'

function readEnv(key: string): string {
  const fromProcess = process.env[key]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess
  // electron-vite 는 envPrefix 에 맞는 값을 import.meta.env 로 주입한다
  const meta = (import.meta as { env?: Record<string, string | undefined> }).env
  const fromMeta = meta?.[key]
  return typeof fromMeta === 'string' ? fromMeta : ''
}

export function readSupabaseEnv(): SupabaseEnv {
  return { url: readEnv(URL_KEY).trim(), anonKey: readEnv(ANON_KEY).trim() }
}

/** 두 값이 모두 있어야 동기화 기능을 켤 수 있다 */
export function hasSupabaseEnv(): boolean {
  const e = readSupabaseEnv()
  return e.url.startsWith('https://') && e.anonKey.length > 0
}
```
- [ ] Step 8: `pnpm test -- sync-env` 통과(기대 출력 `Test Files  1 passed`) → `pnpm lint` → 커밋
```
git commit -m "$(cat <<'EOF'
Supabase 스키마·RLS 정책과 비개발자용 설정 문서 추가

- supabase/schema.sql: 8개 표 + 전 테이블 RLS 4종 정책(user_id = auth.uid())
- audit 테이블은 만들지 않는다(유출면 축소)
- docs/supabase-설정.md: 프로젝트 생성부터 .env 작성까지 11단계 안내
- src/main/sync/env.ts: SAMBA_SUPABASE_* 읽기

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: SyncBackend 인터페이스 + supabase-js 클라이언트 + 세션 safeStorage 보관

**Files:** Create `src/main/sync/{backend,session-store,supabase-backend}.ts`, `src/shared/sync.ts`; Test `tests/sync-session-store.test.ts`, `tests/stubs/fake-backend.ts`

**Interfaces:**
```ts
// src/shared/sync.ts
export const SYNC_TABLES = ['settings', 'accounts', 'vault_items', 'bookmarks'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

export interface SyncStatus {
  online: boolean
  pending: number
  lastPulledAt: number | null
  lastError?: string
}

export interface AuthState {
  signedIn: boolean
  email?: string
  plan: 'free' | 'pro'
  deviceId: string | null
  configured: boolean // .env 가 채워져 있는가
}

export interface DeviceDto {
  id: string
  name: string
  os: string
  appVersion: string
  lastSeenAt: number
  revokedAt: number | null
  isCurrent: boolean
}

export interface WorkspaceDto {
  id: number
  remoteId: string | null
  name: string
  color: string | null
  position: number
  isActive: boolean
}
```
```ts
// src/main/sync/backend.ts — 테스트 경계. 여기 위로는 supabase-js 를 모른다
export interface RemoteRow {
  id: string
  [column: string]: unknown
}

export interface SyncBackend {
  signUp(email: string, password: string): Promise<{ userId: string; email: string }>
  signIn(email: string, password: string): Promise<{ userId: string; email: string }>
  oauthUrl(redirectTo: string): Promise<string>
  exchangeCode(code: string): Promise<{ userId: string; email: string }>
  signOut(): Promise<void>
  currentUser(): Promise<{ userId: string; email: string } | null>
  select(table: string, sinceMs: number): Promise<RemoteRow[]>
  upsert(table: string, rows: RemoteRow[]): Promise<void>
  remove(table: string, ids: string[]): Promise<void>
  subscribe(table: string, onChange: () => void): Promise<() => void>
}

export class AuthExpiredError extends Error {}
```

- [ ] Step 1: `src/shared/sync.ts` 를 위 인터페이스 그대로 작성(주석 한국어).
- [ ] Step 2: `src/main/sync/session-store.ts` — supabase-js 의 `storage` 어댑터. 값(refresh token 포함)을 safeStorage 로 감싸 `%APPDATA%/samba-browser/session.bin` 에 둔다.
```ts
// supabase-js 세션 저장소. refresh token 이 평문으로 디스크에 남지 않게
// safeStorage(Windows DPAPI)로 감싸 파일 하나에 보관한다.
// 어떤 값도 렌더러로 나가지 않는다

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface SessionStorageAdapter {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function createSessionStore(
  filePath: string,
  safeStorage?: SafeStorageLike
): SessionStorageAdapter {
  const canEncrypt = (): boolean => !!safeStorage && safeStorage.isEncryptionAvailable()

  const readAll = (): Record<string, string> => {
    if (!existsSync(filePath)) return {}
    try {
      const raw = readFileSync(filePath)
      // 암호화가 불가능한 환경이면 파일을 신뢰하지 않고 버린다(평문 저장은 하지 않는다)
      if (!canEncrypt()) return {}
      const json: unknown = JSON.parse(safeStorage!.decryptString(raw))
      if (typeof json !== 'object' || json === null) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch {
      // 다른 PC 의 DPAPI 로 만든 파일 등 — 조용히 버리고 다시 로그인하게 둔다
      return {}
    }
  }

  const writeAll = (data: Record<string, string>): void => {
    if (!canEncrypt()) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, safeStorage!.encryptString(JSON.stringify(data)))
    } catch (e: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('세션 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }

  return {
    getItem: (key) => readAll()[key] ?? null,
    setItem: (key, value) => {
      const data = readAll()
      data[key] = value
      writeAll(data)
    },
    removeItem: (key) => {
      const data = readAll()
      delete data[key]
      if (Object.keys(data).length === 0) {
        try {
          if (existsSync(filePath)) unlinkSync(filePath)
        } catch {
          // 파일이 이미 없으면 할 일 없음
        }
        return
      }
      writeAll(data)
    }
  }
}
```
- [ ] Step 3: 실패 테스트 `tests/sync-session-store.test.ts` — 임시 디렉터리 + 스텁 safeStorage(접두사 방식, `tests/vault-service.test.ts` 의 `makeSafeStorage` 와 같은 패턴)로 ① set→get 왕복 ② 파일 내용에 원문 문자열이 **그대로 들어 있지 않음**(`readFileSync(...).toString()` 에 값 미포함 단언) ③ `isEncryptionAvailable()===false` 면 파일이 생기지 않음 ④ 마지막 키 제거 시 파일 삭제.
- [ ] Step 4: `src/main/sync/supabase-backend.ts` — `SyncBackend` 를 supabase-js 로 구현. 401/`JWT expired` 는 `AuthExpiredError` 로 바꿔 던진다.
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AuthExpiredError, type RemoteRow, type SyncBackend } from './backend'
import type { SessionStorageAdapter } from './session-store'
import { readSupabaseEnv } from './env'

// 인증 만료로 볼 응답 코드/문구
const AUTH_EXPIRED = ['PGRST301', '401', 'jwt expired', 'invalid refresh token']

function raise(message: string): never {
  const m = message.toLowerCase()
  if (AUTH_EXPIRED.some((p) => m.includes(p))) throw new AuthExpiredError(message)
  throw new Error(message)
}

export function createSupabaseBackend(storage: SessionStorageAdapter): SyncBackend {
  const env = readSupabaseEnv()
  const client: SupabaseClient = createClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 데스크톱 앱은 URL 해시가 없다. 코드 교환은 우리가 직접 한다
      detectSessionInUrl: false,
      flowType: 'pkce',
      storage
    }
  })

  const identity = (user: { id: string; email?: string } | null): { userId: string; email: string } => {
    if (!user) raise('사용자 정보를 받지 못했습니다')
    return { userId: user.id, email: user.email ?? '' }
  }

  return {
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async oauthUrl(redirectTo) {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true }
      })
      if (error) raise(error.message)
      if (!data.url) raise('구글 로그인 주소를 받지 못했습니다')
      return data.url
    },
    async exchangeCode(code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code)
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signOut() {
      await client.auth.signOut()
    },
    async currentUser() {
      const { data } = await client.auth.getUser()
      return data.user ? { userId: data.user.id, email: data.user.email ?? '' } : null
    },
    async select(table, sinceMs) {
      const { data, error } = await client
        .from(table)
        .select('*')
        .gt('updated_at', new Date(sinceMs).toISOString())
        .order('updated_at', { ascending: true })
      if (error) raise(error.message)
      return (data ?? []) as RemoteRow[]
    },
    async upsert(table, rows) {
      if (rows.length === 0) return
      const { error } = await client.from(table).upsert(rows)
      if (error) raise(error.message)
    },
    async remove(table, ids) {
      if (ids.length === 0) return
      const { error } = await client.from(table).delete().in('id', ids)
      if (error) raise(error.message)
    },
    async subscribe(table, onChange) {
      // Realtime 은 "있으면 좋은" 기능이다. 실패해도 폴링으로 계속 동작해야 한다
      try {
        const channel = client
          .channel(`samba-${table}`)
          .on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange())
          .subscribe()
        return () => {
          void client.removeChannel(channel)
        }
      } catch (e: unknown) {
        console.warn('Realtime 구독 실패(폴링으로 계속)', e instanceof Error ? e.message : String(e))
        return () => {}
      }
    }
  }
}
```
- [ ] Step 5: `tests/stubs/fake-backend.ts` — 메모리 테이블 기반 가짜 백엔드(`createFakeBackend()`)를 만든다. `upsert` 는 id 로 덮어쓰고, `select(table, since)` 는 `updated_at > since` 행만, `signIn` 은 고정 userId, `subscribe` 는 등록한 콜백을 `fire(table)` 로 수동 발화. 이후 모든 sync 테스트는 이것만 쓴다(네트워크 없음).
- [ ] Step 6: `pnpm test -- sync-session-store` 통과 → `pnpm lint` → 커밋: `동기화 백엔드 인터페이스와 supabase 클라이언트·세션 보관 추가`

---

### Task 3: 인증 — 이메일 가입/로그인 + 구글 OAuth(samba://auth 루프백)

**Files:** Create `src/main/sync/{oauth,auth}.ts`; Modify `src/main/index.ts`(딥링크 등록·단일 인스턴스), `src/main/ipc/handlers.ts`, `src/shared/ipc.ts`, `src/preload/renderer.ts`, `src/renderer/src/types/samba.d.ts`; Test `tests/sync-oauth.test.ts`, `tests/sync-auth.test.ts`

**Interfaces:**
```ts
// src/main/sync/oauth.ts (순수 함수)
export const OAUTH_REDIRECT = 'samba://auth'
export function parseAuthCallback(url: string): { code?: string; error?: string } | null

// src/main/sync/auth.ts
export interface AuthDeps {
  backend: SyncBackend
  openExternal: (url: string) => Promise<void>
  configured: boolean
}
export class AuthService {
  constructor(deps: AuthDeps)
  state(): AuthState
  restore(): Promise<AuthState>
  signUp(email: string, password: string): Promise<AuthState>
  signIn(email: string, password: string): Promise<AuthState>
  signInGoogle(): Promise<void>            // 브라우저를 열기만 한다. 완료는 handleCallback
  handleCallback(url: string): Promise<AuthState>
  signOut(): Promise<AuthState>
  onStateChanged(fn: (s: AuthState) => void): void
  markExpired(): void                       // 401 감지 시 sync 엔진이 호출
}
```
**IPC (전부 `handleFromRenderer`):** `auth:state`, `auth:signUp`, `auth:signIn`, `auth:signInGoogle`, `auth:signOut` / push `auth:stateChanged`

- [ ] Step 1: 실패 테스트 `tests/sync-oauth.test.ts` — `parseAuthCallback('samba://auth?code=abc')` → `{code:'abc'}`; `samba://auth#access_token=..&refresh_token=..` 처럼 프래그먼트로 와도 `code` 없으면 `{error:'no-code'}`; `samba://auth?error=access_denied&error_description=...` → `{error:'access_denied'}`; `samba://newtab` 등 다른 경로 → `null`; `https://evil.com/auth?code=x` → `null`(스킴 검증).
- [ ] Step 2: `src/main/sync/oauth.ts` 구현
```ts
// 구글 OAuth 가 돌아오는 딥링크(samba://auth?code=...) 파싱 — 순수 함수
export const OAUTH_REDIRECT = 'samba://auth'

const SCHEME = 'samba:'
const HOST = 'auth'

export interface AuthCallback {
  code?: string
  error?: string
}

/** samba://auth 콜백이면 결과를, 아니면 null 을 돌려준다 */
export function parseAuthCallback(raw: string): AuthCallback | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== SCHEME) return null
  // samba://auth → host 'auth', samba:///auth 처럼 들어오는 경우 pathname 도 본다
  const target = url.host || url.pathname.replace(/^\/+/, '')
  if (target !== HOST) return null

  const error = url.searchParams.get('error')
  if (error) return { error }
  const code = url.searchParams.get('code')
  if (code) return { code }
  // 암묵적 흐름(#access_token=…)은 PKCE 를 쓰는 우리 설정에서는 오지 않는다
  return { error: 'no-code' }
}
```
- [ ] Step 3: 실패 테스트 `tests/sync-auth.test.ts` — 가짜 백엔드로 ① `configured:false` 면 `state().configured === false` 이고 `signIn` 이 "Supabase 설정 필요" 에러 ② `signIn` 성공 시 `signedIn:true`·`email` 채워짐·`onStateChanged` 1회 발화 ③ `signInGoogle()` 이 `openExternal` 을 백엔드가 준 URL 로 1회 호출하고 아직 `signedIn:false` ④ `handleCallback('samba://auth?code=abc')` 후 `signedIn:true` ⑤ `handleCallback('samba://auth?error=access_denied')` 는 throw 하고 상태 불변 ⑥ `signOut()` 후 `signedIn:false` ⑦ `markExpired()` 후 `signedIn:false`.
- [ ] Step 4: `src/main/sync/auth.ts` 구현. `state()` 는 항상 `AuthState` 를 돌려주고 **토큰은 절대 담지 않는다**. `signInGoogle()` 은 `backend.oauthUrl(OAUTH_REDIRECT)` → `openExternal(url)` 만 한다.
- [ ] Step 5: `src/main/index.ts` 배선 — Windows 딥링크.
```ts
// 구글 로그인이 samba://auth 로 돌아오려면 OS 에 기본 프로토콜 처리기로 등록돼야 한다.
// 개발 모드(electron.exe 로 실행)는 실행 인자를 함께 넘겨야 등록이 유효하다
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('samba', process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('samba')
}

// 두 번째 인스턴스로 들어오는 딥링크를 첫 인스턴스로 넘긴다(Windows 방식)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const deepLink = argv.find((a) => a.startsWith('samba://'))
    if (deepLink) void handleDeepLink(deepLink)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  // macOS 대비(2b 범위는 Windows 지만 분기만 둔다)
  app.on('open-url', (e, url) => {
    e.preventDefault()
    void handleDeepLink(url)
  })
}
```
`handleDeepLink` 는 `registerIpc` 가 돌려준 `auth` 를 써서 `parseAuthCallback` 결과가 있을 때만 `auth.handleCallback(url)` 을 호출하고, 실패는 `console.error` 로만 남긴다(값·코드 미기록).
- [ ] Step 6: `internal-protocol.ts` 보강 — `samba://auth` 가 탭 안에서 렌더링되는 일이 없게, 내부 프로토콜 핸들러에서 host 가 `auth` 면 `new Response(null, { status: 204 })` 를 돌려준다(웹 콘텐츠로 해석 금지). 기존 `samba://newtab` 동작은 그대로.
- [ ] Step 7: `src/shared/ipc.ts` 에 채널 추가 → `handlers.ts` 에 `handleFromRenderer(IPC.authState, ...)` 등 5개 + `auth.onStateChanged((s) => send(IPC.authStateChanged, s))` 배선 → `preload/renderer.ts` 에 `window.samba.auth` API → `samba.d.ts` 타입.
- [ ] Step 8: `pnpm test -- sync-oauth sync-auth` 통과 → `pnpm typecheck` → 커밋: `계정 인증 추가: 이메일 가입·로그인과 구글 OAuth(samba://auth 딥링크)`

---

### Task 4: 로컬 스키마 확장 — workspaces / sync_outbox / sync_state + 동기화 컬럼

**Files:** Modify `src/main/db/schema.ts`, `src/main/db/migrations.ts`; Test `tests/db.test.ts`(확장)

**Interfaces:** `schema` 에 `workspaces`, `syncOutbox`, `syncState` 추가. 기존 표에 `remoteId`/`workspaceId`/`deletedAt`(+ `bookmarks.updatedAt`) 추가.

- [ ] Step 1: 실패 테스트 — `tests/db.test.ts` 에 케이스 추가: ① `workspaces` insert/select 왕복 ② `sync_outbox` insert 후 `select` 로 `op='upsert'` 조회 ③ `accounts` 에 `remote_id`/`workspace_id`/`deleted_at` 컬럼 존재(`PRAGMA table_info` 를 `db.drizzle.$client.exec` 으로 확인) ④ 같은 DB 를 두 번 열어도 0005 가 중복 적용되지 않음.
- [ ] Step 2: `schema.ts` 에 표 추가(기존 표 정의는 컬럼만 덧붙인다)
```ts
// 작업공간(브라우저 프로필) — 북마크·금고 항목·설정 세트를 가르는 상위 계층
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 서버(Supabase)의 uuid. 아직 올리지 않았으면 null
  remoteId: text('remote_id'),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at')
})

// 변경 로그 — 로컬 쓰기마다 한 행. 온라인이면 즉시, 아니면 쌓아 두고 재연결 시 전송한다
export const syncOutbox = sqliteTable('sync_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 'settings' | 'accounts' | 'vault_items' | 'bookmarks'
  table: text('table').notNull(),
  // 로컬 행 식별자(settings 는 설정 키 문자열, 그 외는 숫자 id 의 문자열)
  rowId: text('row_id').notNull(),
  op: text('op').notNull(),
  // 전송 시점에 다시 읽으면 되므로 보통 비어 있다. settings 처럼 DB 밖 값만 담는다
  payload: text('payload'),
  createdAt: integer('created_at').notNull(),
  triedAt: integer('tried_at'),
  error: text('error')
})

// 동기화 부가 상태. 'lastPulledAt' | 'deviceId' | 'userId' | 'settings:<key>:updatedAt'
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})
```
그리고 `accounts`/`vaultItems` 에 `remoteId: text('remote_id')`, `workspaceId: integer('workspace_id')`, `deletedAt: integer('deleted_at')` 를, `bookmarks` 에 같은 3개 + `updatedAt: integer('updated_at')` 를 추가한다. `sites`·`bookmarkFolders`·`auditLog` 는 건드리지 않는다(동기화 대상 아님 — 사이트는 `accounts.host` 로, 폴더는 `folderPath` 로 복원된다).
- [ ] Step 3: `migrations.ts` 에 0005 추가(기존 방식 그대로: 태그 + SQL 문자열 배열 + alias)
```ts
  {
    // 2b 동기화 — 작업공간·변경 로그·동기화 상태 표와, 기존 표의 원격 id/작업공간/삭제 표식
    tag: '0005_sync_workspaces',
    sql: [
      'CREATE TABLE `workspaces` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`remote_id` text,\n\t`name` text NOT NULL,\n\t`color` text,\n\t`position` integer DEFAULT 0 NOT NULL,\n\t`is_active` integer DEFAULT false NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer\n);',
      'CREATE UNIQUE INDEX `workspaces_remote_id_unique` ON `workspaces` (`remote_id`);',
      'CREATE TABLE `sync_outbox` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`table` text NOT NULL,\n\t`row_id` text NOT NULL,\n\t`op` text NOT NULL,\n\t`payload` text,\n\t`created_at` integer NOT NULL,\n\t`tried_at` integer,\n\t`error` text\n);',
      'CREATE INDEX `sync_outbox_table_row_idx` ON `sync_outbox` (`table`, `row_id`);',
      'CREATE TABLE `sync_state` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL\n);',
      'ALTER TABLE `accounts` ADD `remote_id` text;',
      'ALTER TABLE `accounts` ADD `workspace_id` integer;',
      'ALTER TABLE `accounts` ADD `deleted_at` integer;',
      'ALTER TABLE `vault_items` ADD `remote_id` text;',
      'ALTER TABLE `vault_items` ADD `workspace_id` integer;',
      'ALTER TABLE `vault_items` ADD `deleted_at` integer;',
      'ALTER TABLE `bookmarks` ADD `remote_id` text;',
      'ALTER TABLE `bookmarks` ADD `workspace_id` integer;',
      'ALTER TABLE `bookmarks` ADD `updated_at` integer;',
      'ALTER TABLE `bookmarks` ADD `deleted_at` integer;'
    ],
    aliases: ['0005_stage2b_sync']
  }
```
- [ ] Step 4: `pnpm test -- db` 통과(기대: `Test Files  1 passed`) → 커밋: `로컬 스키마 확장: 작업공간·변경 로그·동기화 상태 표 추가(0005)`

---

### Task 5: 병합 규칙 순수 함수 (LWW · 합집합 · tombstone)

**Files:** Create `src/main/sync/merge.ts`; Test `tests/sync-merge.test.ts`

**Interfaces:**
```ts
export const TOMBSTONE_TTL_DAYS = 30
export const TOMBSTONE_TTL_MS = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000

export interface Syncable {
  remoteId: string
  updatedAt: number
  deletedAt: number | null
}

export type MergeDecision = 'local' | 'remote' | 'equal'

export function decideLww(local: Syncable | null, remote: Syncable | null): MergeDecision
export interface BookmarkLike extends Syncable { folderPath: string; url: string }
export function bookmarkKey(b: Pick<BookmarkLike, 'folderPath' | 'url'>): string
export function mergeBookmarks(local: BookmarkLike[], remote: BookmarkLike[]): BookmarkLike[]
export function expiredTombstones<T extends Syncable>(rows: T[], now: number): T[]
```

- [ ] Step 1: 실패 테스트 `tests/sync-merge.test.ts`
  - `decideLww`: 원격만 있으면 `'remote'`, 로컬만 있으면 `'local'`, `updatedAt` 큰 쪽 승, 같으면 `'equal'`, 삭제(tombstone)도 `updatedAt` 규칙을 그대로 따름(삭제가 최신이면 `'remote'`)
  - `bookmarkKey`: `folderPath` 는 앞뒤 `/` 정규화, `url` 은 소문자 스킴/호스트 + 트레일링 슬래시 제거 후 비교 → `'북마크바/개발'+'https://Example.com/'` 과 `'/북마크바/개발/'+'https://example.com'` 이 같은 키
  - `mergeBookmarks`: 양쪽에만 있는 것은 **둘 다 남고**(합집합), 같은 키는 1개만 남으며 그중 `updatedAt` 큰 쪽의 `title`/`position` 채택, 한쪽이 tombstone 이고 그게 더 최신이면 결과도 tombstone
  - `expiredTombstones`: `deletedAt` 이 30일보다 오래된 행만 반환, 29일 59분은 미포함
- [ ] Step 2: 구현
```ts
// 동기화 충돌 해결 규칙 — 순수 함수만 둔다(DB·네트워크 의존 없음).
// 설정·계정·금고 = LWW(updatedAt 큰 쪽), 북마크 = 합집합, 삭제 = tombstone 30일

export const TOMBSTONE_TTL_DAYS = 30
export const TOMBSTONE_TTL_MS = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000

export interface Syncable {
  remoteId: string
  updatedAt: number
  deletedAt: number | null
}

export type MergeDecision = 'local' | 'remote' | 'equal'

/** 마지막 수정 시각이 큰 쪽이 이긴다. 삭제도 하나의 수정으로 본다 */
export function decideLww(local: Syncable | null, remote: Syncable | null): MergeDecision {
  if (!local && !remote) return 'equal'
  if (!local) return 'remote'
  if (!remote) return 'local'
  if (remote.updatedAt > local.updatedAt) return 'remote'
  if (local.updatedAt > remote.updatedAt) return 'local'
  return 'equal'
}

export interface BookmarkLike extends Syncable {
  folderPath: string
  url: string
  title: string
  position: number
}

function normalizePath(path: string): string {
  return path.split('/').filter((s) => s.trim().length > 0).join('/')
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '')
  }
}

/** 합집합 판정의 동일성 키 — 같은 폴더의 같은 URL 은 한 개다 */
export function bookmarkKey(b: Pick<BookmarkLike, 'folderPath' | 'url'>): string {
  return `${normalizePath(b.folderPath)}\n${normalizeUrl(b.url)}`
}

/** 북마크는 합집합. 같은 키가 겹치면 updatedAt 이 큰 쪽 한 개만 남긴다 */
export function mergeBookmarks(local: BookmarkLike[], remote: BookmarkLike[]): BookmarkLike[] {
  const byKey = new Map<string, BookmarkLike>()
  for (const row of [...local, ...remote]) {
    const key = bookmarkKey(row)
    const prev = byKey.get(key)
    if (!prev || row.updatedAt > prev.updatedAt) byKey.set(key, row)
  }
  return [...byKey.values()]
}

/** 30일이 지난 tombstone — 호출부가 이 행들만 물리 삭제한다 */
export function expiredTombstones<T extends Syncable>(rows: T[], now: number): T[] {
  return rows.filter((r) => r.deletedAt !== null && now - r.deletedAt >= TOMBSTONE_TTL_MS)
}
```
- [ ] Step 3: `pnpm test -- sync-merge` 통과 → 커밋: `동기화 병합 규칙 추가: LWW·북마크 합집합·30일 tombstone`

---

### Task 6: 평문 유출 방지 런타임 검사 (guard)

**Files:** Create `src/main/sync/guard.ts`; Test `tests/sync-guard.test.ts`

**Interfaces:**
```ts
export const VAULT_SYNC_ALLOWED_KEYS: readonly string[]
export class PlaintextLeakError extends Error {}
export function assertNoPlaintext(table: string, row: Record<string, unknown>): void
```

- [ ] Step 1: 실패 테스트 `tests/sync-guard.test.ts` — ① 허용 키만 있는 `vault_items` 행은 통과 ② `password`/`value`/`secret`/`plaintext` 키가 있으면 `PlaintextLeakError` ③ 허용 목록 밖의 임의 키(`fields`)도 거부 ④ `fields_ciphertext` 가 문자열이면(바이트가 아니면) 거부 ⑤ `accounts` 등 다른 표는 키 화이트리스트를 적용하지 않지만 `password`·`secret` 키는 여전히 거부 ⑥ `SYNC_TABLES` 에 `'audit'` 이 없음.
- [ ] Step 2: 구현
```ts
// 동기화 전송 직전 마지막 방어선.
// vault_items 는 허용 컬럼 화이트리스트로, 나머지 표는 금지 키 목록으로 검사한다.
// 여기서 걸리면 전송을 중단하고 에러를 남긴다(값은 로그에 절대 넣지 않는다)

export class PlaintextLeakError extends Error {}

// vault_items_sync 에 올라갈 수 있는 컬럼 전부. label 만 사용자 지정 이름이라 평문이다
export const VAULT_SYNC_ALLOWED_KEYS: readonly string[] = [
  'id',
  'user_id',
  'workspace_id',
  'account_id',
  'type',
  'label',
  'fields_ciphertext',
  'iv',
  'aad',
  'updated_at',
  'deleted_at'
]

// 어떤 표에서도 나타나면 안 되는 키 조각
const FORBIDDEN_KEY_PARTS = ['password', 'secret', 'plaintext', 'token', 'apikey', 'api_key']

function isBytes(v: unknown): boolean {
  return v instanceof Uint8Array || Buffer.isBuffer(v)
}

/** 전송 직전 검사. 위반이면 던진다 — 호출부는 잡아서 전송을 중단하고 기록한다 */
export function assertNoPlaintext(table: string, row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase()
    // 'value' 는 settings_sync 의 정상 컬럼이므로 표를 구분해서 본다
    if (lower === 'value' && table !== 'settings_sync') {
      throw new PlaintextLeakError(`${table}: 평문 가능성이 있는 컬럼 '${key}' 가 포함됐습니다`)
    }
    if (FORBIDDEN_KEY_PARTS.some((p) => lower.includes(p))) {
      throw new PlaintextLeakError(`${table}: 금지된 컬럼 '${key}' 가 포함됐습니다`)
    }
  }
  if (table !== 'vault_items_sync') return

  for (const key of Object.keys(row)) {
    if (!VAULT_SYNC_ALLOWED_KEYS.includes(key)) {
      throw new PlaintextLeakError(`vault_items_sync: 허용되지 않은 컬럼 '${key}'`)
    }
  }
  if (!isBytes(row.fields_ciphertext) || !isBytes(row.iv)) {
    throw new PlaintextLeakError('vault_items_sync: 암호문·iv 는 바이트여야 합니다')
  }
  if (typeof row.aad !== 'string' || row.aad.length === 0) {
    throw new PlaintextLeakError('vault_items_sync: aad 가 비어 있습니다')
  }
}
```
- [ ] Step 3: `pnpm test -- sync-guard` 통과 → 커밋: `동기화 전송 직전 평문 유출 검사 추가`

---

### Task 7: 변경 로그(outbox) + 매퍼 + 푸시

**Files:** Create `src/main/sync/{outbox,mappers,push}.ts`; Modify `src/main/vault/repo.ts`·`service.ts`(쓰기 지점에서 outbox 기록), `src/main/bookmarks/repo.ts`, `src/main/settings/store.ts`; Test `tests/sync-outbox.test.ts`, `tests/sync-push.test.ts`

**Interfaces:**
```ts
// outbox.ts
export class SyncOutbox {
  constructor(db: Db)
  record(table: SyncTable, rowId: string, op: 'upsert' | 'delete', payload?: string): void
  pending(limit?: number): OutboxRow[]
  count(): number
  clear(ids: number[]): void
  markFailed(ids: number[], error: string): void
}

// mappers.ts — 로컬 행 → 원격 행. vault 는 마스터 키로 fields JSON 을 통째로 봉투 암호화한다
export function accountToRemote(row: AccountRow, ctx: MapCtx): RemoteRow
export function vaultItemToRemote(row: VaultItemRow, ctx: MapCtx & { key: Buffer }): RemoteRow
export function bookmarkToRemote(row: BookmarkSyncRow, ctx: MapCtx): RemoteRow
export function settingToRemote(key: string, value: unknown, updatedAt: number, ctx: MapCtx): RemoteRow
export function vaultSyncAad(remoteId: string): string   // `sync:vault_items:${remoteId}`

// push.ts
export interface PushDeps { db: Db; backend: SyncBackend; outbox: SyncOutbox; vault: VaultService
  settings: SettingsReader; userId: string; workspaceRemoteId: string }
export async function pushAll(deps: PushDeps): Promise<{ sent: number; failed: number; skipped: number }>
```

- [ ] Step 1: 실패 테스트 `tests/sync-outbox.test.ts`(메모리 DB) — ① `record` 후 `count()===1` ② 같은 `(table,rowId)` 를 두 번 upsert 로 기록하면 **최신 1건만** 남음(중복 접기) ③ upsert 뒤 delete 를 기록하면 delete 만 남음 ④ `clear` 로 제거 ⑤ `markFailed` 후 `pending()` 에 `error`·`triedAt` 반영.
- [ ] Step 2: `outbox.ts` 구현(접기 규칙: `record` 시 같은 `(table,rowId)` 의 기존 행을 먼저 DELETE 한 뒤 삽입).
- [ ] Step 3: 실패 테스트 `tests/sync-push.test.ts`(메모리 DB + 가짜 백엔드 + 실제 `VaultService` 잠금 해제) —
  - ① 계정 1건 저장 후 `pushAll` → 가짜 백엔드의 `accounts_sync` 에 1행, 로컬 `accounts.remote_id` 채워짐
  - ② 금고 항목 저장 후 push → `vault_items_sync` 행의 키가 `VAULT_SYNC_ALLOWED_KEYS` 안에 전부 포함되고, `fields_ciphertext` 를 문자열로 바꿔도 저장했던 평문(`'sup3rs3cret!'`)이 **등장하지 않음**(정규식 단언)
  - ③ 금고가 잠긴 상태면 `vault_items` 항목은 `skipped` 로 남고 outbox 에서 지워지지 않음
  - ④ 매퍼가 금지 컬럼을 넣도록 강제로 조작하면 `PlaintextLeakError` 로 **그 표 전체 전송이 중단**되고 outbox 가 보존됨
  - ⑤ 북마크 push 시 `folder_path` 가 폴더 트리에서 계산됨(`북마크바/개발`)
  - ⑥ `AuthExpiredError` 가 나면 `pushAll` 이 그대로 던지고 outbox 는 보존
- [ ] Step 4: `mappers.ts` 구현 — 핵심은 금고 봉투 암호화.
```ts
import { randomUUID } from 'node:crypto'
import { encrypt } from '../vault/crypto'
import type { RemoteRow } from './backend'

/** 금고 항목 동기화 암호문의 AAD. 원격 id 에 묶어 다른 행으로 옮겨 붙일 수 없게 한다 */
export function vaultSyncAad(remoteId: string): string {
  return `sync:vault_items:${remoteId}`
}

export interface MapCtx {
  userId: string
  workspaceRemoteId: string
}

export interface VaultItemLocal {
  id: number
  remoteId: string | null
  accountRemoteId: string | null
  type: string
  label: string
  // 로컬 vault_items.fields 원문(JSON 문자열). 평문 필드가 섞여 있으므로 통째로 암호화한다
  fieldsJson: string
  updatedAt: number
  deletedAt: number | null
}

/**
 * 로컬 항목을 원격 행으로 바꾼다.
 * fields JSON 은 url·text 같은 평문 필드를 포함하므로, 개별 필드 암호문에 더해
 * **JSON 전체를 마스터 키로 한 번 더 감싸(봉투 암호화)** 올린다. 서버는 바이트만 본다
 */
export function vaultItemToRemote(row: VaultItemLocal, ctx: MapCtx & { key: Buffer }): RemoteRow {
  const id = row.remoteId ?? randomUUID()
  const aad = vaultSyncAad(id)
  const sealed = encrypt(ctx.key, row.fieldsJson, aad)
  return {
    id,
    user_id: ctx.userId,
    workspace_id: ctx.workspaceRemoteId,
    account_id: row.accountRemoteId,
    type: row.type,
    label: row.label,
    fields_ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    aad,
    updated_at: new Date(row.updatedAt).toISOString(),
    deleted_at: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString()
  }
}
```
계정·북마크·설정 매퍼도 같은 형태로 작성한다(`accounts_sync` 는 `urls`/`tags` 를 JSON 배열로, `agent_access` 를 그대로; `bookmarks_sync` 는 `folder_path` 계산값; `settings_sync` 는 `{user_id, workspace_id, key, value, updated_at, deleted_at}`).
- [ ] Step 5: `push.ts` 구현 — 표 단위 루프. 각 행마다 `assertNoPlaintext(remoteTable, row)` 를 부르고, 위반이면 그 표를 중단하고 `markFailed` + `console.error('동기화 중단: 평문 검사 실패', e.message)`. 성공하면 `remote_id` 를 로컬에 기록하고 outbox 를 `clear`. 금고 잠김이면 `vault_items` 표만 건너뛴다(`skipped`).
- [ ] Step 6: 쓰기 지점 배선 — `VaultService.upsertAccount/putItem/deleteItem/deleteAccounts`, `BookmarkRepo.createLink/renameLink/moveLink/remove`, `SettingsStore.set` 에서 `outbox.record(...)` 호출. `SettingsStore` 는 DB 를 모르므로 `setOutboxRecorder(fn)` 주입 훅을 둔다(테스트에서는 미주입 = no-op). **동기화 대상 설정 키 화이트리스트**를 `src/shared/sync.ts` 에 둔다.
```ts
// 기기마다 달라야 하는 값(마지막 URL·패널 폭·기기 기억·확장 경로)은 동기화하지 않는다
export const SYNCED_SETTING_KEYS = [
  'model', 'language', 'dangerWords', 'maxToolCalls', 'permissionMode', 'finalConfirm',
  'vaultAutoLockMinutes', 'vaultAccessPolicy', 'vaultAutoSubmit', 'vaultAutoUpdatePassword',
  'vaultExcludedHosts', 'homeUrl', 'newTabUrl', 'searchEngine',
  'agentNotify', 'agentSound', 'agentTabCleanupMinutes', 'taskModels'
] as const
```
- [ ] Step 7: `pnpm test -- sync-outbox sync-push` 통과 → `pnpm typecheck` → 커밋: `변경 로그와 푸시 구현: 금고는 봉투 암호화 후 암호문만 전송`

---

### Task 8: 풀(pull) + 동기화 엔진(60초 폴링 · Realtime · 상태 통지)

**Files:** Create `src/main/sync/{pull,engine}.ts`; Modify `src/main/ipc/handlers.ts`, `src/shared/ipc.ts`, `src/preload/renderer.ts`, `samba.d.ts`; Test `tests/sync-pull.test.ts`, `tests/sync-engine.test.ts`

**Interfaces:**
```ts
// pull.ts
export interface PullDeps extends PushDeps { }
export async function pullAll(deps: PullDeps): Promise<{ applied: number; conflicts: number; pruned: number }>

// engine.ts
export const SYNC_POLL_INTERVAL_MS = 60_000
export class SyncEngine {
  constructor(deps: EngineDeps)
  start(): void            // 즉시 1회 sync + 60초 인터벌 + Realtime 구독 시도
  stop(): void
  status(): SyncStatus
  syncNow(): Promise<SyncStatus>
  onStatusChanged(fn: (s: SyncStatus) => void): void
}
```
**IPC:** `sync:status`, `sync:now`(둘 다 `handleFromRenderer`) / push `sync:statusChanged`

- [ ] Step 1: 실패 테스트 `tests/sync-pull.test.ts` — ① 원격에만 있는 계정이 로컬에 생김 ② 원격 `updated_at` 이 더 크면 로컬을 덮어씀, 로컬이 더 크면 유지(LWW) ③ 원격 금고 항목을 같은 마스터 키로 복호화해 `fields` 복원(값 왕복 성공) ④ AAD 가 다른 행으로 바꿔치기되면 복호화 실패로 그 행만 건너뛰고 나머지는 적용(에러 로그에 값 없음) ⑤ 북마크는 양쪽 것이 **둘 다** 남음 ⑥ 원격 tombstone 이 최신이면 로컬에 `deleted_at` 반영 ⑦ 30일 지난 tombstone 은 물리 삭제(`pruned` 증가) ⑧ `audit_log` 는 어떤 경로로도 건드리지 않음.
- [ ] Step 2: `pull.ts` 구현 — `backend.select(table, lastPulledAt)` → 매퍼 역변환 → `decideLww`/`mergeBookmarks` 적용 → 로컬 반영 → `sync_state.lastPulledAt` 갱신 → `expiredTombstones` 물리 삭제. 금고 항목은 `decrypt(key, ciphertext, iv, aad)` 실패 시 그 행만 건너뛰고 `console.warn('금고 항목 복호화 실패(건너뜀)', remoteId)` — **값도 암호문도 로그에 넣지 않는다**.
- [ ] Step 3: 실패 테스트 `tests/sync-engine.test.ts`(가짜 타이머 `vi.useFakeTimers()`) — ① `start()` 시 즉시 1회 pull+push ② 60초 경과마다 1회씩 추가 실행(`vi.advanceTimersByTimeAsync(60_000)`) ③ `stop()` 후에는 더 실행되지 않음 ④ 백엔드가 `AuthExpiredError` 를 던지면 `onAuthExpired` 콜백이 1회 호출되고 `status().online === false` ⑤ 오프라인(네트워크 에러) 시 outbox 가 보존되고 `status().pending` 이 유지되며, 다음 주기에 재전송 성공하면 `pending===0` ⑥ Realtime 구독이 throw 해도 `start()` 가 성공하고 폴링은 계속 ⑦ `subscribe` 콜백 발화 시 즉시 1회 동기화.
- [ ] Step 4: `engine.ts` 구현. 상태 변화는 `onStatusChanged` 로만 통지하고, `lastError` 에는 예외 메시지만 담는다(스택·페이로드 금지).
- [ ] Step 5: IPC 배선 — `handleFromRenderer(IPC.syncStatus, () => engine.status())`, `handleFromRenderer(IPC.syncNow, () => engine.syncNow())`, `engine.onStatusChanged((s) => send(IPC.syncStatusChanged, s))`. 로그인 시 `engine.start()`, 로그아웃/401 시 `engine.stop()` + `vault.lock()`.
- [ ] Step 6: `pnpm test -- sync-pull sync-engine` 통과 → `pnpm typecheck` → 커밋: `동기화 엔진 추가: 60초 폴링·Realtime 구독·풀 병합과 tombstone 정리`

---

### Task 9: 기기 목록 + 원격 로그아웃

**Files:** Create `src/main/sync/devices.ts`; Modify `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`; Test `tests/sync-devices.test.ts`

**Interfaces:**
```ts
export interface DeviceDeps { backend: SyncBackend; db: Db; userId: string
  hostname: () => string; osLabel: () => string; appVersion: () => string }
export class DeviceService {
  constructor(deps: DeviceDeps)
  ensureRegistered(): Promise<string>       // sync_state.deviceId 없으면 만들고 upsert
  list(): Promise<DeviceDto[]>
  revoke(deviceId: string): Promise<void>
  heartbeat(): Promise<void>                // last_seen_at 갱신(동기화 주기마다)
  isRevoked(): Promise<boolean>             // 내 기기가 취소됐는지
}
```
**IPC:** `devices:list`, `devices:revoke` (`handleFromRenderer`)

- [ ] Step 1: 실패 테스트 — ① `ensureRegistered()` 두 번 호출해도 기기 행이 1개(같은 id, `sync_state.deviceId` 유지) ② `list()` 결과에 `isCurrent` 가 정확히 1건 `true` ③ `revoke(다른기기)` 후 그 행의 `revoked_at` 이 채워짐 ④ 내 기기를 revoke 하면 `isRevoked()===true` ⑤ `heartbeat()` 이 `last_seen_at` 을 갱신.
- [ ] Step 2: 구현. 기기 이름 기본값은 `os.hostname()`, OS 는 `${type()} ${release()}`, 버전은 `app.getVersion()`(테스트에서는 주입).
- [ ] Step 3: `SyncEngine` 에 배선 — 각 주기 시작 시 `devices.isRevoked()` 가 true 면 `auth.signOut()` + `vault.lock()` + `engine.stop()`. `AuthExpiredError` 경로와 같은 처리로 합친다.
- [ ] Step 4: `pnpm test -- sync-devices` 통과 → 커밋: `기기 목록과 원격 로그아웃 추가`

---

### Task 10: 복구 키(24자 base32 6그룹) + recovery_wrapped_key

**Files:** Create `src/main/vault/recovery.ts`; Modify `src/main/vault/service.ts`, `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`; Test `tests/vault-recovery.test.ts`

**Interfaces:**
```ts
export const RECOVERY_KEY_CHARS = 24
export const RECOVERY_GROUP_SIZE = 4
export const RECOVERY_GROUPS = 6
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32(I·L·O·U 제외)

export function generateRecoveryKey(): string          // 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'
export function normalizeRecoveryKey(input: string): string   // 대문자·하이픈 제거·O→0·I/L→1 교정
export function isValidRecoveryKey(input: string): boolean
export function formatRecoveryKey(compact: string): string
export async function wrapMasterKey(master: Buffer, recoveryKey: string, salt: Uint8Array): Promise<EncryptedBlob>
export async function unwrapMasterKey(blob: EncryptedBlob, recoveryKey: string, salt: Uint8Array): Promise<Buffer>
```
**IPC:** `vault:recoveryCreate`(발급 — 화면 표시용 문자열 1회 반환), `vault:recoveryConfirm`(사용자가 재입력한 값 확인 후에만 저장), `vault:recoveryUnlock`(복구 키로 금고 해제) — 전부 `handleFromRenderer`

- [ ] Step 1: 실패 테스트 `tests/vault-recovery.test.ts` — ① `generateRecoveryKey()` 가 `/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/` 를 만족하고 하이픈 제외 24자 ② 1000회 생성해 중복 없음 ③ `normalizeRecoveryKey('k3f9 abcd-o1il...')` 가 소문자·공백·혼동 문자를 교정 ④ 잘못된 길이/문자는 `isValidRecoveryKey` false ⑤ `wrapMasterKey`→`unwrapMasterKey` 왕복으로 같은 마스터 키 복원 ⑥ 틀린 복구 키면 throw ⑦ `recoveryCreate` 후 **확인 전에는** `vault_meta.recovery_wrapped_key` 가 없고, `recoveryConfirm(정확한 값)` 후에야 생김 ⑧ `recoveryConfirm(틀린 값)` 은 false 를 돌려주고 아무것도 저장하지 않음 ⑨ 생성된 복구 키 문자열이 DB 어디에도 평문으로 없음(모든 `vault_meta` 값을 문자열화해 단언).
- [ ] Step 2: 구현 — 생성은 `randomBytes(24)` 를 `% 32` 로 매핑하지 않고 **거부 표집**(rejection sampling, 256 을 32 로 나눈 나머지 없는 범위만 사용)으로 편향 없이 뽑는다.
```ts
// 복구 키 — 24자 Crockford base32(I·L·O·U 제외), 4자씩 6그룹. 120비트.
// 생성 화면에서만 화면에 뜨고, 저장되는 것은 "복구 키로 감싼 마스터 키" 뿐이다

import { deriveKey, encrypt, decrypt, randomBytes, type EncryptedBlob } from './crypto'

export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const RECOVERY_KEY_CHARS = 24
export const RECOVERY_GROUP_SIZE = 4
export const RECOVERY_GROUPS = 6
const RECOVERY_AAD = 'recovery'
// 256 을 32 로 나눈 나머지가 0 이라 0~255 전부 써도 편향이 없지만,
// 알파벳이 32 가 아닌 값으로 바뀌어도 안전하도록 상한을 계산해 둔다
const MAX_UNBIASED = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length

export function generateRecoveryKey(): string {
  let out = ''
  while (out.length < RECOVERY_KEY_CHARS) {
    for (const byte of randomBytes(RECOVERY_KEY_CHARS)) {
      if (byte >= MAX_UNBIASED) continue
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
      if (out.length === RECOVERY_KEY_CHARS) break
    }
  }
  return formatRecoveryKey(out)
}

export function formatRecoveryKey(compact: string): string {
  const groups: string[] = []
  for (let i = 0; i < compact.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(compact.slice(i, i + RECOVERY_GROUP_SIZE))
  }
  return groups.join('-')
}

/** 사람이 옮겨 적다 생기는 혼동(O/0, I·L/1)을 교정하고 하이픈·공백을 없앤다 */
export function normalizeRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

export function isValidRecoveryKey(input: string): boolean {
  const compact = normalizeRecoveryKey(input)
  if (compact.length !== RECOVERY_KEY_CHARS) return false
  return [...compact].every((c) => RECOVERY_ALPHABET.includes(c))
}

/** 복구 키에서 유도한 키로 마스터 키를 감싼다. salt 는 vault_meta.recovery_salt */
export async function wrapMasterKey(
  master: Buffer,
  recoveryKey: string,
  salt: Uint8Array
): Promise<EncryptedBlob> {
  const wrapper = await deriveKey(normalizeRecoveryKey(recoveryKey), salt)
  return encrypt(wrapper, master.toString('base64'), RECOVERY_AAD)
}

/** 복구 키로 마스터 키를 되찾는다. 틀리면 예외가 난다 */
export async function unwrapMasterKey(
  blob: EncryptedBlob,
  recoveryKey: string,
  salt: Uint8Array
): Promise<Buffer> {
  const wrapper = await deriveKey(normalizeRecoveryKey(recoveryKey), salt)
  return Buffer.from(decrypt(wrapper, blob.ciphertext, blob.iv, RECOVERY_AAD), 'base64')
}
```
- [ ] Step 3: `VaultService` 에 `createRecoveryKey(): string`(메모리에만 보관, 10분 TTL), `confirmRecoveryKey(input): Promise<boolean>`(일치해야 `recovery_salt`/`recovery_wrapped_key` 를 `vault_meta` 에 저장 + `settings_sync` 의 `recovery_wrapped_key` 키로 outbox 기록), `unlockWithRecoveryKey(input): Promise<boolean>` 추가. 감사 로그에 `recovery_create`/`recovery_unlock` 기록(값 없음).
- [ ] Step 4: IPC 3개 + preload + 타입 배선. `vault:recoveryCreate` 응답만 평문 복구 키를 돌려주며, 렌더러는 이를 상태에 담되 **확인 완료 즉시 폐기**한다.
- [ ] Step 5: `pnpm test -- vault-recovery` 통과 → 커밋: `복구 키 발급·확인·복구 해제 추가(24자 base32 6그룹)`

---

### Task 11: 작업공간(브라우저 프로필)

**Files:** Create `src/main/workspace/service.ts`, `src/renderer/src/components/workspace/WorkspaceSwitcher.tsx`, `src/renderer/src/stores/workspaceStore.ts`; Modify `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`, `src/main/browser/tab-manager.ts`(파티션 접두사), `src/main/window.ts`(단축키), `src/main/vault/repo.ts`·`src/main/bookmarks/repo.ts`(범위 필터), i18n; Test `tests/workspace-service.test.ts`

**Interfaces:**
```ts
export const MAX_WORKSPACES = 9
export class WorkspaceService {
  constructor(db: Db, settings: SettingsWriter)
  list(): WorkspaceDto[]
  ensureDefault(): WorkspaceDto              // 없으면 '기본' 작업공간 1개 생성·활성
  active(): WorkspaceDto
  create(name: string, color?: string): WorkspaceDto
  rename(id: number, name: string): WorkspaceDto
  remove(id: number): void                   // tombstone. 마지막 1개는 삭제 불가
  switchTo(id: number): WorkspaceDto
  switchToIndex(index: number): WorkspaceDto | null   // Ctrl+Alt+1~9
  partitionPrefix(): string                  // `persist:ws${activeId}-`
  onChanged(fn: (w: WorkspaceDto) => void): void
}
```
**IPC:** `workspace:list`, `workspace:create`, `workspace:switch`, `workspace:rename`, `workspace:delete` (`handleFromRenderer`) / push `workspace:changed`

- [ ] Step 1: 실패 테스트 `tests/workspace-service.test.ts` — ① `ensureDefault()` 가 '기본' 1건 생성·활성, 두 번 호출해도 1건 ② `create` 후 `list()` 2건, 활성은 그대로 ③ `switchTo` 후 `active().id` 변경 + `onChanged` 발화 ④ `switchToIndex(2)` 가 position 순 2번째로 전환, 없는 번호는 `null` ⑤ `MAX_WORKSPACES` 초과 생성 시 throw ⑥ 마지막 1개 삭제 시 throw ⑦ `remove` 는 행을 지우지 않고 `deletedAt` 설정(tombstone) ⑧ `partitionPrefix()` 가 활성 id 를 반영 ⑨ 삭제된 작업공간이 활성이었으면 남은 것 중 첫 번째로 자동 전환.
- [ ] Step 2: 구현. 활성 작업공간 id 는 `settings.activeWorkspaceId`(신규 설정, 기본 0 = 미지정)에 저장하고, 동기화 대상에서 제외한다(기기마다 다를 수 있음).
- [ ] Step 3: 범위 필터 — `VaultRepo.listAccounts`/`listItems` 와 `BookmarkRepo.tree` 에 `workspaceId` 인자를 추가하고, `workspace_id IS NULL OR workspace_id = ?` 로 거른다(기존 데이터는 NULL 이라 모든 작업공간에서 보인다 → 첫 실행 시 기본 작업공간 id 로 일괄 채우는 1회 백필을 `ensureDefault()` 안에서 수행).
- [ ] Step 4: `tab-manager.ts` — `create({profile})` 의 파티션 문자열 앞에 `workspace.partitionPrefix()` 를 붙인다. 전환 시 기존 탭은 그대로 두고 **새로 여는 탭부터** 새 파티션을 쓴다(열려 있는 세션을 끊지 않는다 — 화면에 안내 띠 1줄).
- [ ] Step 5: `Ctrl+Alt+1`~`Ctrl+Alt+9` 전역 단축키 등록(`globalShortcut` 이 아니라 `win.webContents.on('before-input-event')` 로 창 포커스 시에만 — 다른 앱의 단축키를 뺏지 않는다).
- [ ] Step 6: `WorkspaceSwitcher.tsx` — 사이드바 상단의 작은 칩 목록(이름·색 점), `+` 로 생성, 우클릭 메뉴로 이름 변경·삭제. i18n ko/en 추가.
- [ ] Step 7: 동기화 배선 — `workspaces` 표를 push/pull 대상에 추가(LWW). `workspace_id` 는 원격 uuid 로 매핑.
- [ ] Step 8: `pnpm test -- workspace-service` 통과 → `pnpm typecheck` → 커밋: `작업공간 추가: 생성·전환·범위 필터와 Ctrl+Alt+1~9 단축키`

---

### Task 12: AI 연결 — 제공자 감지 · API 키 보관 · 작업별 모델

**Files:** Create `src/main/ai/{providers,keys,models}.ts`, `src/shared/ai.ts`; Modify `src/main/agent/runner.ts`, `src/shared/settings.ts`, `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`; Test `tests/ai-providers.test.ts`, `tests/ai-keys.test.ts`, `tests/ai-models.test.ts`

**Interfaces:**
```ts
// src/shared/ai.ts
export const AI_PROVIDERS = ['claude_subscription', 'api_key', 'service_credit'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]
export const API_KEY_VENDORS = ['anthropic', 'openai', 'gemini'] as const
export type ApiKeyVendor = (typeof API_KEY_VENDORS)[number]
export const TASK_MODEL_KEYS = ['fast', 'standard', 'deep', 'visual'] as const
export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number]
export type TaskModels = Record<TaskModelKey, string>

export interface AiProviderStatus {
  id: AiProviderId
  // 'connected' | 'not_installed' | 'needs_login' | 'disabled' | 'unset'
  state: 'connected' | 'not_installed' | 'needs_login' | 'disabled' | 'unset'
  // 키는 마스킹 문자열만. 실제 값은 절대 렌더러로 가지 않는다
  maskedKeys: Partial<Record<ApiKeyVendor, string>>
  detail?: string
}
```
```ts
// src/main/ai/keys.ts
export class ApiKeyStore {
  constructor(filePath: string, safeStorage?: SafeStorageLike)
  set(vendor: ApiKeyVendor, key: string): void
  // 메인 내부 전용. 렌더러로 나가는 경로가 존재하지 않는다
  get(vendor: ApiKeyVendor): string | null
  remove(vendor: ApiKeyVendor): void
  masked(): Partial<Record<ApiKeyVendor, string>>
}
export function maskApiKey(key: string): string   // 'sk-ant-••••abcd'

// src/main/ai/models.ts
export const DEFAULT_TASK_MODELS: Record<AiProviderId, TaskModels>
export function resolveModel(models: TaskModels, key: TaskModelKey): string
export function remapOnProviderChange(current: TaskModels, from: AiProviderId, to: AiProviderId):
  { models: TaskModels; changed: TaskModelKey[] }
```

- [ ] Step 1: 실패 테스트 `tests/ai-keys.test.ts` — ① `set`→`get` 왕복 ② 저장 파일 바이트에 원문 키가 등장하지 않음 ③ `masked()` 가 `sk-ant-api03-abcdefgh1234` → `sk-ant-••••1234` 형태이고 원문 미포함 ④ 짧은 키(8자 미만)는 전부 `••••` ⑤ `remove` 후 `get`===null ⑥ safeStorage 불가 환경에서는 저장하지 않고 `get`===null.
- [ ] Step 2: `keys.ts` 구현(`session-store.ts` 와 같은 safeStorage 파일 패턴, 파일명 `ai-keys.bin`). **`ApiKeyStore.get` 을 호출하는 곳은 `agent/provider.ts` 하나뿐**임을 주석에 명시.
- [ ] Step 3: 실패 테스트 `tests/ai-providers.test.ts`(파일 존재 확인·프로세스 실행을 주입 가능한 함수로 분리) — ① 자격 파일 있음 + `claude --version` 성공 → `'connected'` ② 자격 파일 없음 + 실행 성공 → `'needs_login'` ③ 실행 실패(ENOENT) → `'not_installed'` ④ 실행이 3초 넘게 걸리면 타임아웃으로 `'not_installed'` ⑤ `service_credit` 은 항상 `'disabled'`(detail = 'Pro 요금제에서 제공 예정' i18n 키) ⑥ 결과에 키·토큰 문자열이 전혀 없음.
- [ ] Step 4: `providers.ts` 구현
```ts
// AI 연결 경로 감지. Claude Code 로그인 여부는 자격 파일 존재 + `claude --version` 으로 본다.
// 어떤 반환값에도 키·토큰이 담기지 않는다

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { AiProviderStatus } from '../../shared/ai'

const VERSION_TIMEOUT_MS = 3000

// Claude Code 가 로그인 자격을 두는 자리(둘 중 하나만 있어도 로그인으로 본다)
export const CLAUDE_CREDENTIAL_PATHS = [
  join(homedir(), '.claude', '.credentials.json'),
  join(homedir(), '.claude.json')
]

export interface ProviderProbes {
  fileExists: (path: string) => boolean
  runVersion: () => Promise<boolean>
}

export function defaultProbes(): ProviderProbes {
  return {
    fileExists: existsSync,
    runVersion: () =>
      new Promise((resolve) => {
        const child = execFile('claude', ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err) => {
          resolve(!err)
        })
        child.on('error', () => resolve(false))
      })
  }
}

/** Claude 구독(= Claude Code 로그인) 상태 */
export async function detectClaudeSubscription(probes: ProviderProbes): Promise<AiProviderStatus> {
  const installed = await probes.runVersion()
  if (!installed) {
    return { id: 'claude_subscription', state: 'not_installed', maskedKeys: {} }
  }
  const loggedIn = CLAUDE_CREDENTIAL_PATHS.some((p) => probes.fileExists(p))
  return {
    id: 'claude_subscription',
    state: loggedIn ? 'connected' : 'needs_login',
    maskedKeys: {}
  }
}
```
- [ ] Step 5: 실패 테스트 `tests/ai-models.test.ts` — ① `DEFAULT_TASK_MODELS.claude_subscription` 이 fast/standard/deep/visual 4칸 모두 채워짐 ② `resolveModel` 이 빈 문자열이면 기본값으로 대체 ③ `remapOnProviderChange('claude_subscription'→'api_key')` 가 등급을 유지하며 대체하고 `changed` 에 바뀐 칸만 담김 ④ 매핑 불가한 칸은 해당 제공자 기본값으로 떨어짐.
- [ ] Step 6: `models.ts` 구현 + `shared/settings.ts` 에 설정 추가
```ts
  // AI 연결 경로와 작업별 모델
  aiProvider: 'claude_subscription' as const,
  taskModels: {
    fast: 'haiku',
    standard: 'sonnet',
    deep: 'opus',
    visual: 'sonnet'
  },
  // 에이전트 동작
  agentNotify: true,
  agentSound: false,
  // 에이전트가 연 탭을 몇 분 뒤 정리할지(0 이면 정리 안 함)
  agentTabCleanupMinutes: 15,
  // 작업공간(기기 로컬 — 동기화하지 않는다)
  activeWorkspaceId: 0,
  // 확장 폴더 경로(로컬 전용)
  extensionPaths: [] as string[]
```
zod 스키마에도 같은 필드를 `.catch(기본값)` 으로 추가한다(`taskModels` 는 `z.object({fast:z.string(), standard:z.string(), deep:z.string(), visual:z.string()}).catch(DEFAULT_SETTINGS.taskModels)`).
- [ ] Step 7: `runner.ts` 수정 — `model: s.model` 을 `model: resolveModel(s.taskModels, 'standard')` 로 바꾼다. `s.model` 설정은 하위 호환으로 남기되 설정 화면에서는 작업별 모델 표가 대체한다.
- [ ] Step 8: IPC 6개(`ai:providers` `ai:setProvider` `ai:setApiKey` `ai:testKey` `ai:taskModels` `ai:setTaskModel`) 를 `handleFromRenderer` 로 등록. `ai:providers` 응답은 `AiProviderStatus[]`(마스킹만), `ai:testKey` 는 벤더별 모델 목록 1회 호출로 `{ok:boolean}` 만 반환하고 응답 본문을 로그에 남기지 않는다.
- [ ] Step 9: `pnpm test -- ai-providers ai-keys ai-models` 통과 → `pnpm typecheck` → 커밋: `AI 연결 추가: 구독 감지·API 키 안전 보관·작업별 모델`

---

### Task 13: 설정 화면 골격 + 계정 / AI / 보안 / 에이전트 섹션 + 키마스터 이동

**Files:** Modify `src/renderer/src/pages/SettingsPage.tsx`; Create `src/renderer/src/components/settings/{GeneralSection,AppearanceSection,AccountSection,SecuritySection,AgentSection,AiSection,KeymasterSection,PlaceholderSection,DeviceList,RecoveryKeyDialog}.tsx`, `src/renderer/src/components/ai/{ProviderCard,TaskModelTable}.tsx`, `src/renderer/src/stores/{authStore,syncStore,aiStore}.ts`; Modify i18n `ko.json`/`en.json`

**구성(스펙 그대로):**
```
개인      일반 · 모양 · 계정 · 요금제(자리) · 보안
에이전트  에이전트 · AI 연결 · 키마스터 · 자동화(자리) · 개발자(자리)
```

- [ ] Step 1: `SettingsPage.tsx` 를 좌측 240px 섹션 목록 + 우측 패널 구조로 재작성. 섹션 정의는 배열 상수 하나(`SECTIONS: { group: 'personal'|'agent'; key: string; labelKey: string }[]`)로 두고, 본문은 `switch` 로 컴포넌트를 고른다. 기존 `SettingsSection`/`SettingsRow`/`SegmentedGroup` 은 그대로 재사용하고 `components/settings/shared.tsx` 로 옮겨 공유한다.
- [ ] Step 2: **일반** — 기본 검색엔진, 시작 화면(홈 주소·새 탭 주소), 언어(ko/en), 가져오기 버튼 2개(기존 `ImportPanel` 재사용). 기존 SettingsPage 의 해당 항목을 그대로 이 섹션으로 옮긴다.
- [ ] Step 3: **모양** — 테마(시스템/밝게/어둡게 — 설정만 저장하고 실제 적용은 `document.documentElement.dataset.theme`), 줌(80~150%), 사이드바 구성 토글(북마크/채팅), 단축키 표(읽기 전용, `Ctrl+Alt+1~9` 포함).
- [ ] Step 4: **계정** — 미로그인 시 가입/로그인 폼(이메일·비밀번호 + "구글로 계속하기"), `.env` 미설정이면 폼 대신 "동기화를 쓰려면 Supabase 설정이 필요합니다 → `docs/supabase-설정.md`" 안내 카드. 로그인 시 이메일·요금제 배지, **기기 목록**(`DeviceList.tsx`: 이름·OS·버전·마지막 활동·"이 기기" 배지·원격 로그아웃 버튼), 동기화 상태(`online`/`pending`/`lastPulledAt`/`lastError` + "지금 동기화" 버튼), 로그아웃, 위험 구역(계정 삭제 — 확인 문구 입력 후에만 활성).
- [ ] Step 5: **보안** — 금고 자동 잠금(분), AI 접근 정책(3값), 제외 도메인 목록 편집, **복구 키 재발급**(`RecoveryKeyDialog.tsx`: 1) 경고 화면 2) 24자 키 표시 + 복사/인쇄 버튼 3) **재입력 확인 칸** — 정확히 입력해야 [완료] 활성 4) 완료). 기존 `VaultSettingsPanel` 의 해당 항목을 이 섹션으로 옮긴다.
- [ ] Step 6: **에이전트** — 완료 알림, 완료 사운드, 후속 지시 큐(실행 중이면 쌓기), 에이전트가 연 탭 자동 정리(분, 0 = 안 함, 기본 15).
- [ ] Step 7: **AI 연결** — `ProviderCard.tsx` 3장을 스펙 순서대로. ① Claude 구독: 상태 배지(연결됨/미설치/로그인 필요) + 실패 시 설치 안내 링크 ② 내 API 키: Claude/OpenAI/Gemini 3칸, 입력 즉시 저장하고 화면에는 마스킹만, "연결 확인" 버튼 ③ 서비스 크레딧: 카드는 보이되 **비활성**, "Pro 요금제에서 제공 예정". 하단 `TaskModelTable.tsx`: Fast/Standard/Deep/Visual 4행 × (용도·모델 선택·쓰이는 곳) — 제공자 전환 시 `remapOnProviderChange` 결과의 `changed` 가 비어 있지 않으면 알림 띠 표시.
- [ ] Step 8: **키마스터** — 2단계에서 만든 패널을 이 섹션으로 **이동**(화면 재구현 없이 라우팅만 변경) + 내보내기 버튼(Task 14).
- [ ] Step 9: **요금제 / 자동화 / 개발자** — `PlaceholderSection.tsx` 하나로 제목 + "다음 단계에서 제공" 안내만.
- [ ] Step 10: i18n `ko.json`/`en.json` 에 `settings.*`·`account.*`·`sync.*`·`ai.*`·`recovery.*`·`workspace.*` 키 추가(두 파일의 키 집합이 같은지 `tests/settings.test.ts` 에 단언 추가).
- [ ] Step 11: `pnpm test && pnpm lint && pnpm typecheck` 통과 → 커밋: `설정 화면 전면 개편: 개인·에이전트 9개 섹션과 계정·AI 연결 화면 추가`

---

### Task 14: 키마스터 내보내기(CSV / JSON)

**Files:** Create `src/main/vault/export.ts`, `src/renderer/src/components/settings/ExportDialog.tsx`; Modify `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`, i18n; Test `tests/vault-export.test.ts`

**Interfaces:**
```ts
export type ExportFormat = 'csv' | 'json'
export const EXPORT_CSV_HEADER = 'name,url,username,password,note'
export interface ExportRequest { format: ExportFormat; master: string }
export interface ExportResult { itemCount: number; filePath: string }
export function buildCsv(rows: ExportRow[]): string
export function buildJson(rows: ExportRow[], now: number): string
export async function exportVault(deps: ExportDeps, req: ExportRequest): Promise<ExportResult>
```

- [ ] Step 1: 실패 테스트 `tests/vault-export.test.ts` — ① `buildCsv` 첫 줄이 정확히 `name,url,username,password,note` ② 쉼표·따옴표·개행이 든 값이 RFC4180 로 escape 되고, 2단계의 `parsePasswordCsv` 로 되읽었을 때 **행 수와 값이 일치**(왕복 테스트) ③ `buildJson` 이 `{version:1, exportedAt, items:[{type,label,host,username,fields}]}` 모양 ④ 금고 잠김이면 `exportVault` 가 `'locked'` 로 throw ⑤ 마스터 비밀번호가 틀리면 `'invalid-master'` 로 throw 하고 파일을 만들지 않음 ⑥ 성공 시 `audit_log` 에 `action='export'` 1건 ⑦ 사용자가 저장 다이얼로그를 취소하면 파일도 감사 로그도 없음.
- [ ] Step 2: 구현 — `exportVault` 는 ① `vault.state()==='unlocked'` 확인 ② `vault.verifyMaster(req.master)`(신규 메서드: 저장된 salt·kdf_params 로 키를 다시 유도해 `checkVerifier`, `timingSafeEqual` 사용) ③ `dialog.showSaveDialog` — **경고 문구를 `message`/`nameFieldLabel` 에 고정 노출**("내보낸 파일에는 비밀번호가 평문으로 들어갑니다. 저장 후 안전한 곳으로 옮기고 원본은 지우세요.") ④ 파일 작성 ⑤ 감사 로그 `export`. 평문 배열은 작성 직후 `rows.length = 0` 으로 비운다.
- [ ] Step 3: `ExportDialog.tsx` — 형식 선택(CSV/JSON) + 마스터 비밀번호 재입력 + 빨간 경고 문구 고정. i18n ko/en.
- [ ] Step 4: `handleFromRenderer(IPC.vaultExport, (req: ExportRequest) => exportVault(deps, req))` 배선. 응답에는 `itemCount`·`filePath` 만 담고 값은 담지 않는다.
- [ ] Step 5: `pnpm test -- vault-export` 통과 → 커밋: `키마스터 내보내기 추가: CSV·JSON(잠금 해제와 마스터 재입력 필수)`

---

### Task 15: 확장 관리 (2b 후반)

**Files:** Create `src/main/extensions/manager.ts`, `src/renderer/src/components/settings/ExtensionsSection.tsx`; Modify `handlers.ts`, `ipc.ts`, `preload/renderer.ts`, `samba.d.ts`, `SettingsPage.tsx`(개발자 섹션 자리 대체), i18n; Test `tests/extensions-manager.test.ts`

**Interfaces:**
```ts
export interface ExtensionDto { id: string; name: string; version: string; path: string }
export interface ExtensionHost {
  loadExtension: (path: string) => Promise<{ id: string; name: string; version: string }>
  removeExtension: (id: string) => void
}
export class ExtensionManager {
  constructor(host: ExtensionHost, settings: SettingsWriter)
  loadSaved(): Promise<ExtensionDto[]>     // 시작 시 저장된 경로를 순서대로 로드
  list(): ExtensionDto[]
  add(path: string): Promise<ExtensionDto>
  remove(id: string): void
}
```
**IPC:** `ext:list`, `ext:load`, `ext:remove` (`handleFromRenderer`)

- [ ] Step 1: 실패 테스트 — ① `add` 성공 시 `settings.extensionPaths` 에 경로 추가 + `list()` 1건 ② 같은 경로를 두 번 add 하면 1건 유지 ③ 로드 실패(manifest 없음)면 throw 하고 경로가 저장되지 않음 ④ `remove` 후 목록·설정 양쪽에서 사라짐 ⑤ `loadSaved()` 에서 한 개가 실패해도 나머지는 로드되고 실패한 경로는 설정에서 제거됨 ⑥ `extensionPaths` 가 `SYNCED_SETTING_KEYS` 에 없음(동기화 안 함).
- [ ] Step 2: 구현. 실제 호스트는 `session.defaultSession.extensions.loadExtension(path, { allowFileAccess: false })`. **CRX 설치·웹스토어 연동은 하지 않는다**(압축 해제된 폴더만).
- [ ] Step 3: `ExtensionsSection.tsx` — 폴더 선택 버튼(`dialog.showOpenDialog({properties:['openDirectory']})`), 목록(이름·버전·경로·제거), 그리고 **제한 안내 문단 고정 노출**: MV3 일부 API 미지원 · 백그라운드 서비스워커 제약 · 확장 자동 업데이트 없음 · 프로필별 분리는 partition 단위로만.
- [ ] Step 4: `pnpm test -- extensions-manager` 통과 → 커밋: `확장 관리 추가: 압축 해제된 크롬 확장 폴더 로드·목록·제거`

---

### Task 16: 2PC 통합 검증 + 문서

**Files:** Create `docs/검수/2026-09-XX-2b단계-동기화.md`; Modify `docs/실행방법.md`, `README.md`, `docs/supabase-설정.md`(문제 해결 보강)

- [ ] Step 1: 컨트롤러(사람)가 스펙 "완료 기준" 10개를 순서대로 수행하고 결과 표로 기록한다. 값(비밀번호·복구 키·토큰)은 기록하지 않고 성공/실패와 원인만 적는다.
  1. PC A 가입 → 금고 설정 → 복구 키 발급·확인 → 계정 3개·북마크 저장
  2. PC B 로그인 → 같은 마스터 비밀번호 → PC A 의 계정·북마크·설정이 보이고 금고 복호화 성공
  3. PC B 오프라인 수정 → 온라인 복귀 시 자동 전송 → PC A 반영(LWW)
  4. 양쪽 동시 수정 → `updatedAt` 늦은 쪽이 남음
  5. 북마크는 양쪽 것이 둘 다 남음(합집합)
  6. PC A 에서 PC B 원격 로그아웃 → PC B 가 다음 주기(최대 60초)에 로그아웃 + 금고 잠금
  7. Supabase Table Editor 에서 `audit` 표가 **없음**을 눈으로 확인
  8. AI 연결 카드에서 Claude 구독 감지 → 작업별 모델 4칸 지정 → 실제 작업이 지정 모델로 실행(로그 확인)
  9. 작업공간 2개 → `Ctrl+Alt+1/2` 전환 시 북마크·금고 목록 분리
  10. 내보내기 CSV 를 2단계 가져오기로 되읽어 항목 수 일치
- [ ] Step 2: `docs/실행방법.md` 에 "계정 만들고 두 PC 연결하기" 절 추가(`.env` 준비 → 가입 → 복구 키 → 두 번째 PC).
- [ ] Step 3: `README.md` 상태 갱신(2b 완료 범위), 알려진 한계 명시: Realtime 은 환경에 따라 동작하지 않을 수 있고 그때는 60초 폴링으로만 동기화됨 / 구글 로그인은 Windows 딥링크 등록이 필요해 개발 모드에서는 `pnpm build:unpack` 산출물로 확인하는 편이 확실함 / 확장은 MV3 일부 API 미지원.
- [ ] Step 4: `pnpm test && pnpm lint && pnpm typecheck && pnpm build` 전부 통과 → 커밋: `2b단계 검증 결과와 문서 갱신`

---

## 자체 점검

**스펙 커버리지**

| 스펙 항목 | Task |
|---|---|
| Supabase 스키마 8표 + RLS 4종 정책 + anon 권한 없음 + 서비스 롤 키 금지 | T1 |
| `audit` 테이블 없음 | T1(스키마), T6(`SYNC_TABLES` 단언), T16(눈 확인) |
| Supabase 프로젝트를 사용자가 직접 생성 + `.env` 주입 | T1 |
| 인증: 이메일 + 구글 OAuth(`samba://auth` 루프백) | T3 |
| 세션 보관: refresh token 을 safeStorage 로 감싸 `%APPDATA%` | T2 |
| 금고 동기화: 암호문만 업로드(`fields_ciphertext`/`iv`/`aad`) | T7 |
| 마스터 키 이식(같은 비밀번호로 재유도, salt 동기화) | T7·T8(`settings_sync` 의 salt·kdf_params) |
| 복구 키 24자 base32 6그룹 + 재입력 확인 후 저장 | T10, T13 Step 5 |
| `recovery_wrapped_key` 를 `settings_sync` 에 보관 | T10 Step 3 |
| 변경 로그 기반 푸시/풀, 오프라인 우선 | T7, T8 |
| 충돌: LWW / 북마크 합집합 / 감사 로그 제외 | T5, T8 |
| tombstone 30일 | T5, T8 |
| 폴링 60초 + 시작 시 1회 + Realtime(가능할 때) | T8 |
| 기기 목록 · 원격 로그아웃 · 401 자동 로그아웃 | T9, T8 |
| 브라우저 프로필(작업공간) + `Ctrl+Alt+N` | T11 |
| AI 연결 카드 3종 + API 키 safeStorage 로컬 전용 | T12, T13 Step 7 |
| 작업별 모델 4종 + 제공자 전환 시 자동 대체·알림 띠 | T12, T13 Step 7 |
| 설정 화면 9개 섹션 구성 | T13 |
| 키마스터 섹션 이동(재구현 아님) | T13 Step 8 |
| 키마스터 내보내기 CSV/JSON + 마스터 재입력 + 경고 + 감사 로그 | T14 |
| 확장 관리(압축 해제 폴더만, 제한 명시) | T15 |
| 안전장치 6개(평문 런타임 검사·복구 키 비노출·로그아웃 시 금고 잠금·원격 로그아웃 401·키/토큰 렌더러 미전달·서비스 롤 키 금지) | T6·T10·T8·T9·T12·T1 |
| 완료 기준 10개 | T16 |

**placeholder 없음**: 이 계획서에 `TBD`·`TODO`·"적절히 처리" 문구는 없다. "자리(placeholder) 섹션"(요금제·자동화·개발자)은 스펙이 명시한 **제품 기능**이며, 구현 내용(제목 + 안내 문구)이 T13 Step 9 에 확정돼 있다.

**타입 일관성**
- 동기화 표 이름은 `src/shared/sync.ts` 의 `SYNC_TABLES` 한 곳에서만 정의하고, 원격 표 이름은 `${table}_sync`(단 `workspaces` 는 그대로) 규칙으로 매퍼가 만든다
- `AiProviderId`/`TaskModelKey`/`TaskModels` 는 `src/shared/ai.ts` 한 곳 — 메인(`ai/*`)·설정 zod 스키마·렌더러가 같은 타입을 쓴다
- `AuthState`/`SyncStatus`/`DeviceDto`/`WorkspaceDto` 는 `src/shared/sync.ts` 한 곳 — preload 는 `import type` 으로만 가져온다
- IPC 채널명은 `src/shared/ipc.ts` 의 `IPC` 상수 한 곳. 페이지 프리로드가 쓰는 채널은 2b 에서 **늘어나지 않으므로** `page-constants.ts` 수정이 없다
- 금고 AAD 는 두 층으로 분리: 로컬 필드 암호문 = `${itemId}:${fieldKey}`(2단계 그대로, 변경 없음), 동기화 봉투 = `sync:vault_items:${remoteId}`(T7). 두 값이 섞이지 않도록 `vaultSyncAad()` 한 함수만 후자를 만든다
- `updatedAt`/`deletedAt` 은 로컬에서 **epoch 밀리초 정수**, 원격에서 **ISO 문자열 timestamptz** 이며 변환은 `mappers.ts` 에서만 한다

**비밀값 경로**(2단계 점검에 추가되는 것만)
- 마스터 키: `VaultService` 필드 → `mappers.vaultItemToRemote`(메인 내부) — IPC 로 나가지 않음
- refresh token: `session-store` 파일(safeStorage) ↔ supabase-js 내부 — IPC 로 나가지 않음
- API 키: `ApiKeyStore` 파일(safeStorage) → `agent/provider.ts` — IPC 로는 `maskApiKey()` 결과만
- 복구 키 평문: `vault:recoveryCreate` 응답(1회, 사용자 화면 표시 전용) → 확인 완료 시 렌더러 상태에서 폐기. DB·로그에는 래핑 결과만
- 내보내기 평문: `exportVault` 안에서만 존재하고 파일로 나간 뒤 배열을 비움. IPC 응답에는 건수·경로만

**마이그레이션 안전성**: 0005 는 `CREATE TABLE` 3개와 `ALTER TABLE ADD COLUMN` 9개뿐이라 기존 데이터를 건드리지 않는다(전부 nullable). 기존 행의 `workspace_id` 는 NULL 이라 모든 작업공간에서 보이며, T11 Step 3 의 1회 백필이 기본 작업공간 id 로 채운다. 실패해도 앱은 기존 동작을 유지한다.
