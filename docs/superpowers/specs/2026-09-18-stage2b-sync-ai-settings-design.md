# 2b단계 설계: Supabase 동기화 + 프로필 + AI 연결 설정 + 설정 화면

작성일: 2026-09-18 · 상태: 초안 · 선행: [2단계 금고·가져오기](2026-09-18-stage2-vault-import-design.md)

## 목표

같은 계정으로 **여러 PC에서 설정·계정·금고(암호문)·북마크를 공유**하고, AI 연결 경로(구독/API 키/크레딧)와 작업별 모델을 사용자가 직접 고를 수 있게 한다. 2단계에서 로컬에만 있던 것들에 계정·동기화·설정 껍데기를 씌우는 단계다.

## 범위

포함: Supabase 프로젝트(Auth·테이블·RLS), 마스터 비밀번호 E2E + 복구 키, 로컬 SQLite↔Supabase 동기화 어댑터, 기기 목록·원격 로그아웃, 브라우저 프로필(작업공간), AI 연결 설정 화면, 작업별 모델, 설정 화면 전체 골격, 키마스터 내보내기, 확장 관리(후반).
제외(3단계 이후): 폰 연동, 결제 흐름 학습·Recorder, 요금제 실제 결제(토스페이먼츠·Stripe), 팀 금고, Channels, MCP 서버 노출.

## 핵심 결정

| 결정 | 선택 | 이유 |
|---|---|---|
| 백엔드 | **Supabase**(PostgreSQL + Auth + RLS) | 기술스택 확정. PostgreSQL 표준이라 이사 가능, 동기화 코드는 어댑터로 분리 |
| 인증 | 이메일+비밀번호 · **구글 OAuth** | PRD F17. 구글은 Electron `shell.openExternal` + 로컬 루프백 리다이렉트(`samba://auth`) |
| 세션 보관 | refresh token 을 `safeStorage`(DPAPI)로 감싸 `%APPDATA%` 에 저장 | 재시작 시 자동 로그인 |
| 금고 동기화 | **암호문만 업로드**. 서버는 `ciphertext`·`iv`·`updatedAt` 만 봄 | 마스터 키는 기기 밖으로 나가지 않음(PRD 7, E2E) |
| 마스터 키 이식 | 새 PC에서 같은 마스터 비밀번호 입력 → `vault_meta.salt` 를 서버에서 받아 동일 키 재유도 | salt·kdf_params 는 비밀 아님, 동기화 대상 |
| 복구 키 | 설정 시 **24자**(base32 6그룹, 예 `K3F9-...`) 발급 → 화면 표시 + 복사/인쇄 + **재입력 확인 후에만 다음 단계** | PRD 10-1 "복구 키 발급, 분실 시 복구 불가 고지" |
| 복구 키 동작 | 마스터 키를 복구 키로 한 번 더 감싼 `recovery_wrapped_key` 를 `settings_sync` 에 저장. 마스터 비밀번호 분실 시 복구 키로만 해제 | 두 경로 모두 잃으면 복구 불가(명시) |
| 동기화 방식 | **변경 로그 기반 푸시/풀**. 로컬 쓰기마다 `sync_outbox` 에 행 추가 → 온라인이면 즉시, 아니면 큐에 쌓아 재연결 시 전송 | 오프라인 우선 |
| 충돌 규칙 | 설정·계정·금고 = **LWW(updatedAt 큰 쪽)**, 북마크 = **합집합**(같은 url+folder 는 1개), 감사 로그 = **동기화 안 함**(PC 로컬) | 기술스택 §4 "마지막 수정 시각 우선, 로그는 합치기" |
| 삭제 | **tombstone** — 행을 지우지 않고 `deletedAt` 설정 후 동기화, 30일 뒤 물리 삭제 | 삭제가 되살아나는 사고 방지 |
| 폴링 | 앱 시작 시 1회 풀 + 이후 60초 주기 + Supabase Realtime 구독(가능할 때) | 실시간은 있으면 좋고 없어도 동작 |
| 브라우저 프로필 | 계정 하위 **작업공간** 개념. 북마크·금고 항목·설정 세트가 프로필별로 분리. `Ctrl+Alt+N`(1~9) 전환 | Aside Profiles 대응. 기존 "탭별 partition(계정=프로필)" 은 그대로 유지, 상위 계층만 추가 |
| AI 연결 | 카드 3종: **Claude 구독 / 내 API 키 / 서비스 크레딧(자리)** | PRD §7-0 3단 구조 |
| API 키 보관 | `safeStorage` 로 암호화해 로컬만. **동기화 안 함** | 키는 PC 자산 |
| 작업별 모델 | Fast / Standard / Deep / Visual 4종 + 기본값 | PRD F14, Aside Task models |
| 감사 로그 테이블 | Supabase 에 **만들지 않음** | 유출면 축소 |

## Supabase 스키마

```sql
profiles          id(uuid, = auth.users.id, PK), email, display_name, plan('free'|'pro'), created_at
devices           id(uuid), user_id, name, os, app_version, last_seen_at, revoked_at
settings_sync     user_id, workspace_id, key, value(jsonb), updated_at, deleted_at   -- PK(user_id, workspace_id, key)
accounts_sync     id(uuid), user_id, workspace_id, host, label, username, is_default,
                  agent_access, paused_until, updated_at, deleted_at
vault_items_sync  id(uuid), user_id, workspace_id, account_id, type, label,
                  ciphertext(bytea), iv(bytea), updated_at, deleted_at              -- 평문 컬럼 없음
bookmarks_sync    id(uuid), user_id, workspace_id, folder_path(text), title, url, position, updated_at, deleted_at
recipes           id(uuid), user_id, workspace_id, name, prompt, rules(jsonb), procedure(jsonb), updated_at, deleted_at  -- 4단계용 자리
workspaces        id(uuid), user_id, name, color, position, created_at
```
- `audit` 테이블 없음.
- `vault_items_sync` 는 `ciphertext`·`iv` 외 어떤 평문 필드도 두지 않는다(`label` 은 사용자 지정 이름이라 평문 허용, 문서에 명시).

### RLS 정책

모든 테이블에 `ENABLE ROW LEVEL SECURITY`. 공통 정책 4개(select/insert/update/delete) 전부 `user_id = auth.uid()`. `profiles` 는 `id = auth.uid()`. anon 롤에는 어떤 권한도 부여하지 않는다. 서비스 롤 키는 앱에 **넣지 않고**, 앱은 anon 키 + 사용자 JWT 로만 접근.

## 로컬 스키마 추가 (Drizzle)

```
workspaces     id, remoteId?, name, color, position, isActive, updatedAt
sync_outbox    id, table('settings'|'accounts'|'vault_items'|'bookmarks'|'recipes'),
               rowId, op('upsert'|'delete'), payload(json), createdAt, triedAt?, error?
sync_state     key(PK), value   -- 'lastPulledAt', 'deviceId', 'userId'
```
기존 `accounts`·`vault_items`·`bookmarks` 에 `remoteId`, `updatedAt`, `deletedAt`, `workspaceId` 컬럼 추가. `audit_log` 는 변경 없음(동기화 대상 아님).

## 모듈

- `src/main/sync/` — `client.ts`(supabase-js 초기화·세션 복원), `auth.ts`(가입·로그인·구글 OAuth·로그아웃·기기 등록), `outbox.ts`(변경 로그 기록·재시도), `push.ts`/`pull.ts`(테이블별 매퍼), `merge.ts`(LWW·합집합·tombstone 순수 함수 — 단위 테스트 대상), `devices.ts`
- `src/main/vault/recovery.ts` — 복구 키 생성(24자)·검증·`recovery_wrapped_key` 래핑/언래핑
- `src/main/workspace/` — 작업공간 CRUD, 전환 시 `session.fromPartition` 프리픽스 교체·북마크/금고 범위 필터
- `src/main/ai/` — `providers.ts`(Claude 구독 감지·API 키·크레딧 자리), `keys.ts`(safeStorage 저장), `models.ts`(작업별 모델 매핑 → `agent/provider.ts` 가 소비)
- `src/main/extensions/` — (후반) `session.extensions.loadExtension`, 로드 목록 영속
- 렌더러: `pages/SettingsPage.tsx` + `components/settings/*`(섹션별), `pages/AccountPage.tsx`, `components/ai/ProviderCard.tsx`, `components/workspace/WorkspaceSwitcher.tsx`

## IPC 추가 (`src/shared/ipc.ts` 의 `IPC` 상수에 추가)

| 채널 | 방향 | 내용 |
|---|---|---|
| `auth:state` / `auth:stateChanged` | 양방향 | `{signedIn, email?, plan, deviceId}` |
| `auth:signUp` `auth:signIn` `auth:signInGoogle` `auth:signOut` | R→M | |
| `sync:status` / `sync:statusChanged` | 양방향 | `{online, pending(outbox 건수), lastPulledAt, lastError?}` |
| `sync:now` | R→M | 수동 동기화 |
| `devices:list` `devices:revoke` | R→M | 원격 로그아웃(해당 기기의 refresh token 무효화 + `revoked_at`) |
| `vault:recoveryCreate` `vault:recoveryConfirm` `vault:recoveryUnlock` | R→M | 발급/확인/복구 해제 |
| `workspace:list` `workspace:create` `workspace:switch` `workspace:rename` `workspace:delete` | R→M | |
| `ai:providers` `ai:setProvider` `ai:setApiKey` `ai:testKey` `ai:taskModels` `ai:setTaskModel` | R→M | `ai:providers` 응답에 키는 **마스킹**(`sk-ant-...4자리`)만 |
| `vault:export` | R→M | CSV/JSON 내보내기 |
| `ext:list` `ext:load` `ext:remove` | R→M | (후반) |

응답 형식은 기존 `IpcResult<T>` 유지.

## AI 연결 설정 화면

세 장의 카드(PRD §7-0 순서 그대로):

1. **Claude 구독** — Claude Code 로그인 감지: `~/.claude/` 자격 파일 존재 + `claude --version` 실행 확인 → 상태 배지(연결됨/미설치/로그인 필요). 실패 시 "설치 안내" 링크. 성공 시 Agent SDK 가 그대로 사용.
2. **내 API 키** — Claude / OpenAI / Gemini 3칸. 입력 즉시 `safeStorage.encryptString` 후 저장, 화면엔 마스킹. "연결 확인" 버튼이 모델 목록 1회 호출로 유효성 검사. 값은 렌더러로 되돌려주지 않는다.
3. **서비스 크레딧** — 카드 자체는 표시하되 **비활성**(“Pro 요금제에서 제공 예정”). 요금제 연동은 별도.

하단 **작업별 모델** 표:

| 용도 | 기본값 | 쓰이는 곳 |
|---|---|---|
| Fast | Haiku 급 | 재생 실패 복구, 짧은 판정 |
| Standard | Sonnet 급 | 일반 웹 작업(기본) |
| Deep | Opus 급 | 계획·다단계 판단 |
| Visual | 비전 모델 | 폰 화면·스크린샷·키패드 배치(3단계) |

각 칸은 선택된 제공자가 제공하는 모델 목록에서 고른다. 제공자 전환 시 매핑 가능한 등급으로 자동 대체하고 알림 띠 표시.

## 설정 화면 구성

```
개인    일반 · 모양 · 계정 · 요금제(자리) · 보안
에이전트 에이전트(알림·사운드·후속 지시 큐·탭 자동 정리) · AI 연결 · 키마스터 · 자동화(자리) · 개발자(자리)
```
- **일반**: 기본 검색엔진, 시작 화면, 언어(ko/en), 가져오기 버튼
- **모양**: 테마(시스템/밝게/어둡게), 줌, 사이드바 구성(북마크/채팅), 단축키 표
- **계정**: 프로필·이메일, **기기 목록**(이름·OS·버전·마지막 활동·"이 기기" 표시·원격 로그아웃), 동기화 상태, 로그아웃, 계정 삭제(위험 구역)
- **보안**: 금고 자동 잠금, AI 접근 정책, 제외 도메인, 복구 키 재발급
- **에이전트**: 완료 알림 · 완료 사운드 · 후속 지시 큐(실행 중이면 쌓기) · **에이전트가 연 탭 15분 후 자동 정리**(분 단위 설정)
- **키마스터**: 2단계에서 만든 패널을 이 섹션으로 **이동**(화면 재구현 아님, 라우팅만 변경) + 내보내기
- **자동화 / 개발자**: 제목과 "다음 단계에서 제공" 안내만

## 키마스터 내보내기

- CSV: 크롬 호환 헤더 `name,url,username,password,note` — 가져오기 파서와 대칭
- JSON: `{version, exportedAt, items:[{type, label, host, username, fields{}}]}`
- **금고 잠금 해제 상태 + 마스터 비밀번호 재입력**이 있어야만 실행. 평문이 나가므로 저장 다이얼로그에 경고 문구 고정 노출, 감사 로그에 `export` 기록.

## 확장 관리 (2b 후반)

- Electron `session.defaultSession.extensions.loadExtension(폴더)` 로 **압축 해제된 크롬 확장 폴더**만 로드. CRX 설치·웹스토어 연동 없음.
- 목록 화면: 이름·버전·폴더 경로·제거. 로드 목록은 로컬 설정에 보관(동기화 안 함).
- **제한 명시**: MV3 일부 API 미지원, 백그라운드 서비스워커 제약, 확장 업데이트 자동화 없음, 프로필별 분리는 partition 단위로만.

## 안전장치

- 동기화 전송 직전 `vault_items_sync` payload 에 평문 필드가 없는지 **런타임 검사**(있으면 전송 중단·에러 로그)
- 복구 키는 생성 화면에서만 표시되고 DB·로그에 평문으로 남지 않음
- 로그아웃 시 로컬 DB 는 유지하되 금고는 즉시 잠금, `sync_outbox` 는 보존(재로그인 시 전송)
- 기기 원격 로그아웃 후 해당 PC 는 다음 동기화 시 401 → 자동 로그아웃 + 금고 잠금
- API 키·refresh token 은 렌더러로 절대 전달하지 않음(마스킹 문자열만)
- Supabase URL·anon 키는 빌드 상수. 서비스 롤 키는 앱에 포함 금지

## 완료 기준

1. PC A 에서 가입 → 금고 설정 → 복구 키 발급·확인 → 계정 3개·북마크 저장
2. PC B 에서 같은 계정 로그인 → 같은 마스터 비밀번호 입력 → **PC A 의 계정·북마크·설정이 그대로 보임**, 금고 값 복호화 성공
3. PC B 오프라인 상태에서 항목 수정 → 온라인 복귀 시 자동 전송, PC A 에 반영(LWW 확인)
4. 양쪽에서 같은 항목을 수정 → `updatedAt` 늦은 쪽이 남고 다른 쪽은 알림 없이 덮임(규칙대로)
5. 북마크는 양쪽 것이 **둘 다** 남음(합집합)
6. PC A 에서 PC B 를 원격 로그아웃 → PC B 가 다음 주기에 로그아웃·금고 잠금
7. 감사 로그가 Supabase 어느 테이블에도 없음(수동 확인)
8. AI 연결 카드에서 Claude 구독 감지 → 작업별 모델 4칸 지정 → 실제 작업이 지정 모델로 실행(로그로 확인)
9. 작업공간 2개를 만들어 `Ctrl+Alt+1/2` 전환 시 북마크·금고 목록이 분리되어 보임
10. 내보내기 CSV 를 2단계 가져오기로 되읽어 항목 수가 일치
