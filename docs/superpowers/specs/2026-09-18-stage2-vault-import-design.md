# 2단계 설계: 로컬 DB + 개인정보 금고 + 가져오기 + 자동 로그인

작성일: 2026-09-18 · 상태: 확정(사용자 "계획서 다 되면 진행")

## 목표

사용자의 비밀번호·개인정보를 **AI가 값을 보지 않고** 저장·자동 입력한다. 크롬/웨일 비밀번호 CSV와 북마크 HTML을 가져오고, 가져온 계정으로 실제 사이트에 자동 로그인되는지 검증한다.

## 범위

포함: SQLite 로컬 저장소, 마스터 비밀번호 기반 암호화 금고, CSV/HTML 가져오기, 개인정보 화면(1Password 스타일), AI 자동 채움·자동 로그인 도구, 로그인/결제 정보 자동 저장 제안, 북마크 사이드바(기본), 자동 로그인 검증.
제외(2b): Supabase 로그인·동기화, AI 연결 설정 화면, 결제 흐름 학습(Recorder).

## 핵심 결정

| 결정 | 선택 | 이유 |
|---|---|---|
| DB 엔진 | **sql.js(WASM) + drizzle-orm/sql-js** | 네이티브 빌드 없음(better-sqlite3 는 Electron ABI 리빌드 필요). 수천 행 규모에 충분. 파일 `%APPDATA%/samba-browser/data.db` 로 저장(쓰기 후 300ms 디바운스 export) |
| 키 유도 | **argon2id(hash-wasm)** salt 16B, m=64MiB, t=3, p=1 → 32B 키 | 표준, WASM(네이티브 없음) |
| 암호화 | **AES-256-GCM** 항목별 iv 12B, 인증태그 포함, AAD=item id | 표준 |
| 잠금 | 앱 시작 시 잠김. 마스터 비밀번호 입력 → 키를 메모리에만 보관. 미사용 15분(설정) 후 자동 잠금 | |
| 기기 기억(선택) | "이 PC에서 기억" 켜면 키를 `safeStorage`(DPAPI)로 감싸 저장 → 다음 시작 시 자동 해제 | Aside "Auto lock 1 week" 대응 |
| 마스터 비밀번호 분실 | 복구 불가. 설정 시 복구 키(24자, 별도 파일 저장 안내) 발급 — 2b 에서 Supabase 동기화 시 필수. 이번 단계는 경고 문구만 | |
| AI 접근 | 값은 절대 반환하지 않음. 도구는 **항목 이름/계정 라벨만** 보고 지시. 채움은 메인이 격리 월드에서 직접 | PRD F4 |
| 자동 저장 | 웹페이지 preload(격리 월드)가 비밀번호 필드 있는 폼 제출을 감지 → 메인 → 채팅 패널 상단 카드 "저장할까요?" | PRD F5 |
| 용어 | UI "개인정보", 코드 `vault` | 사용자 결정 |

## 데이터 모델 (Drizzle)

```
sites          id, host(unique), name, loginUrl?, createdAt
accounts       id, siteId, label, username, isDefault, pausedUntil?, createdAt, updatedAt
vault_items    id, accountId?(null=전역), type('login_password'|'payment_password'|'card'|'passport'|'id_card'|'birth_date'|'address'|'phone'|'custom'),
               label, ciphertext(BLOB), iv(BLOB), updatedAt
vault_meta     key(PK), value  — 'salt','verifier'(암호화된 상수),'kdf_params','device_wrapped_key'?
bookmark_folders id, parentId?, name, position
bookmarks      id, folderId?, title, url, position, addedAt
audit_log      id, at, itemId, action('fill'|'reveal'|'import'|'save'), jobId?, source('ai'|'user')
```
`accounts.username` 은 평문(선택에 필요). 비밀번호·카드 등 값은 전부 `vault_items.ciphertext`.

## 모듈

- `src/main/db/` — `client.ts`(sql.js 로드·파일 영속), `schema.ts`, `migrate.ts`(drizzle 마이그레이션 SQL 실행)
- `src/main/vault/` — `crypto.ts`(argon2id·AES-GCM 순수 함수), `service.ts`(setup/unlock/lock/자동잠금, CRUD, reveal, fill 값 조회), `repo.ts`(drizzle 쿼리)
- `src/main/import/` — `passwords-csv.ts`, `bookmarks-html.ts`(순수 파서) + `service.ts`(파일 다이얼로그·중복 처리·감사 로그)
- `src/main/agent/tools.ts` 추가 도구: `list_accounts(host?)`, `fill_secret(elementId, itemType, accountLabel?)`, `login(accountLabel?)`
- `src/preload/page-core.ts` 추가: `fillValue(id, value)`(격리 월드에서 값 세팅, 값은 executeJavaScriptInIsolatedWorld 인자로만 전달), `findLoginFields()`(username/password 후보 id), 폼 제출 감지 → `ipcRenderer.send('vault:capture', {host, username, password})`
- `src/renderer/src/pages/PersonalInfoPage.tsx` + `components/vault/*` — 잠금 해제/설정 화면, 목록·검색·칩, 상세(가려진 값·보기·복사), 추가/편집 모달, 가져오기 버튼, 저장 제안 카드
- `src/renderer/src/components/layout/Sidebar.tsx` — 메뉴 클릭으로 화면 전환(uiStore.view: 'browser'|'personal'), 북마크 트리 섹션

## AI 도구 계약

| 도구 | 입력 | 출력(AI 가 보는 것) |
|---|---|---|
| `list_accounts` | `{host?}` | `[ {label, username(마스킹: 앞2글자+***), types:['login_password','card']} ]` |
| `fill_secret` | `{elementId, itemType, accountLabel?}` | `'ok'` / `'locked: ask user to unlock'` / `'not found'` — 값 없음 |
| `login` | `{accountLabel?}` | 현재 탭에서 username/password 필드 탐지 → 채움 → 제출 → `'submitted'`/`'fields not found'`/`'locked'` |

권한 모드: read_only 에서 `fill_secret`/`login` 거부. guard 에서 `fill_secret` 의 `payment_password`/`card` 는 확인 카드. `login` 은 확인 없음(자동 로그인이 목적).

## 자동 로그인 검증 (완료 기준)

1. 사용자 CSV 가져오기(1,622건) → 중복 병합 결과 표시
2. 대표 사이트 5~10개(네이버·쿠팡·크림·무신사·11번가·다나와·타오바오 등 CSV 에 있는 것) 에 "OO 로그인해" → `login` 도구 → 결과 표 `docs/검수/2026-09-XX-2단계-자동로그인.md`
3. 규칙: 사이트당 1회, 캡차/2FA/보안키패드 → 중단·기록, 값은 로그·화면·AI 어디에도 없음
4. 80% 이상 폼 인식·채움 성공이면 통과(로그인 자체 실패는 원인 분류)

## 안전장치 추가

- `vault:capture` 로 들어온 비밀번호는 메모리 60초 보관 후 폐기, 저장 시 즉시 암호화
- `reveal` 은 잠금 해제 상태 + 사용자 클릭 시만, 감사 로그 기록
- 스냅샷/`textOf` 는 `type=password` 값 절대 포함 안 함(1단계 유지)
- CSV 원본 파일은 가져오기 후 "삭제 권장" 안내
