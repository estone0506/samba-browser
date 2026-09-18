# 2단계 구현 계획: 로컬 DB + 개인정보 금고 + 가져오기 + 자동 로그인

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자의 비밀번호·개인정보를 AI가 값을 보지 않고 저장·자동 입력하며, 크롬/웨일 CSV·북마크 HTML을 가져오고, 가져온 계정으로 실제 사이트 자동 로그인이 되게 한다.

**Architecture:** sql.js(WASM) + drizzle-orm 로컬 DB(`data.db`), argon2id+AES-256-GCM 금고 서비스(메인 프로세스, 키는 메모리), 순수 파서(CSV/Netscape HTML), 격리 월드 `fillValue`로 값 주입(AI 도구는 항목 이름만 다룸), preload 폼 제출 감지 → 저장 제안 카드, 렌더러에 개인정보 페이지(잠금/목록/상세/가져오기)와 뷰 전환.

**Tech Stack:** 1단계 스택 + sql.js, drizzle-orm(sql-js), drizzle-kit, hash-wasm, papaparse, node-html-parser, zod

## Global Constraints

- 1단계 계획의 Global Constraints 전부 유지(세미콜론 없음·작은따옴표·2칸, `any` 금지, 한국어 주석·커밋, i18n `t()`, IPC `{ok,data}|{ok,error}`, 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`)
- **비밀값(비밀번호·카드·결제비밀번호 등)은 AI 도구 결과·`AgentEvent`·로그·스냅샷·테스트 출력 어디에도 나타나지 않는다.** 렌더러로는 사용자가 `보기`를 눌렀을 때만 `vault:reveal` 로 전달
- 실제 사용자 파일(`C:\Users\canno\Documents\네이버 웨일 비밀번호.csv`, `bookmarks_26. 9. 16..html`)은 **테스트 코드에 사용 금지**, 커밋 금지. 단위 테스트는 합성 데이터만
- 격리 월드 id 999, `executeJavaScriptInIsolatedWorld` 사용(1단계와 동일)
- UI 용어: "개인정보"(en "Personal Info"). 코드 식별자는 `vault`
- 렌더러 소스 루트 `src/renderer/src/`

---

## 파일 구조

```
src/shared/
  vault.ts            VaultItemType, VaultItemMeta(값 제외 DTO), AccountDto, SiteDto, ImportResult, IPC 채널 추가
src/main/db/
  client.ts           sql.js 초기화, 파일 로드/디바운스 저장, drizzle 인스턴스
  schema.ts           drizzle 테이블 정의
  migrate.ts          drizzle-kit 생성 SQL 실행
drizzle/              마이그레이션 SQL (drizzle-kit generate)
src/main/vault/
  crypto.ts           deriveKey(argon2id), encrypt/decrypt(AES-256-GCM), randomSalt — 순수 함수
  service.ts          VaultService: setup/unlock/lock/isUnlocked/autoLock, items CRUD, reveal, getSecretForFill, capture 보관
  repo.ts             drizzle 쿼리(sites/accounts/items/audit)
src/main/import/
  passwords-csv.ts    parsePasswordCsv(text): ParsedLogin[]  — 순수
  bookmarks-html.ts   parseNetscapeBookmarks(html): ParsedBookmarkTree — 순수
  service.ts          파일 다이얼로그, 호스트 정규화, 중복 병합, DB 저장, 감사 로그
src/main/bookmarks/repo.ts
src/main/agent/tools.ts       + list_accounts, fill_secret, login
src/main/ipc/handlers.ts      + vault:*, import:*, bookmarks:*
src/preload/page-core.ts      + fillValue, findLoginFields, submitForm, 폼 제출 감지
src/preload/page.ts           + ipcRenderer.send('vault:capture') (isolated world → main)
src/preload/renderer.ts       + vault/import/bookmarks API
src/renderer/src/
  stores/{uiStore(view), vaultStore, bookmarkStore}.ts
  pages/PersonalInfoPage.tsx
  components/vault/{UnlockScreen,SetupScreen,ItemList,ItemDetail,ItemEditor,ImportPanel,CapturePrompt}.tsx
  components/layout/{Sidebar(뷰 전환·북마크 트리), BookmarkTree}.tsx
tests/  crypto, passwords-csv, bookmarks-html, vault-service(sql.js 메모리), agent-tools(login/fill), settings
docs/검수/2026-09-XX-2단계-자동로그인.md
```

---

### Task 1: sql.js + Drizzle 로컬 DB 뼈대

**Files:** Create `src/main/db/{client,schema,migrate}.ts`, `drizzle.config.ts`, `drizzle/0000_*.sql`; Modify `package.json`, `src/main/index.ts`; Test `tests/db.test.ts`

**Interfaces:** Produces `openDatabase(filePath): Promise<Db>` where `Db = { drizzle: SqlJsDatabase<typeof schema>, save(): void, close(): void }`; `schema` exports `sites, accounts, vaultItems, vaultMeta, bookmarkFolders, bookmarks, auditLog`.

- [ ] Step 1: 설치 `pnpm add sql.js drizzle-orm hash-wasm papaparse node-html-parser` / `pnpm add -D drizzle-kit @types/sql.js @types/papaparse`
- [ ] Step 2: `schema.ts`
```ts
import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core'

// 사이트(호스트 단위)
export const sites = sqliteTable('sites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  host: text('host').notNull().unique(),
  name: text('name').notNull(),
  loginUrl: text('login_url'),
  createdAt: integer('created_at').notNull()
})
// 계정(사이트당 여러 개)
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  username: text('username').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  pausedUntil: integer('paused_until'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})
// 비밀 항목 — 값은 항상 암호문
export const vaultItems = sqliteTable('vault_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  label: text('label').notNull(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  iv: blob('iv', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull()
})
export const vaultMeta = sqliteTable('vault_meta', {
  key: text('key').primaryKey(),
  value: blob('value', { mode: 'buffer' }).notNull()
})
export const bookmarkFolders = sqliteTable('bookmark_folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentId: integer('parent_id'),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0)
})
export const bookmarks = sqliteTable('bookmarks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  folderId: integer('folder_id').references(() => bookmarkFolders.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  position: integer('position').notNull().default(0),
  addedAt: integer('added_at')
})
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  itemId: integer('item_id'),
  action: text('action').notNull(),
  jobId: text('job_id'),
  source: text('source').notNull()
})
```
- [ ] Step 3: `client.ts` — `initSqlJs({ locateFile: f => join(__dirname, '../../node_modules/sql.js/dist', f) })` 대신 electron-vite 에서 wasm 을 `resources/sql-wasm.wasm` 로 복사해 `app.getAppPath()` 기준 로드(빌드 시 `extraResources`). 파일 있으면 `new SQL.Database(readFileSync(file))`, 없으면 빈 DB → `migrate()`. `save()` 는 `db.export()` → `writeFileSync(tmp)` → rename. 쓰기 훅: drizzle 실행 후 서비스 계층에서 `scheduleSave()`(300ms 디바운스).
- [ ] Step 4: `drizzle.config.ts` (`dialect: 'sqlite'`, `schema: './src/main/db/schema.ts'`, `out: './drizzle'`) → `pnpm drizzle-kit generate` → SQL 을 `migrate.ts` 에서 순서대로 `db.run()` (자체 `__migrations` 테이블로 적용 여부 기록).
- [ ] Step 5: 테스트 `tests/db.test.ts`: 메모리 DB(`openDatabase(':memory:')`) 열기 → 마이그레이션 → `sites` insert/select 왕복 → `save()` 가 파일 없이도 오류 없음.
- [ ] Step 6: `index.ts` 에서 `openDatabase(join(app.getPath('userData'), 'data.db'))` 를 `registerIpc` 전에 호출해 전달. `pnpm build` 통과, `pnpm dev` 로 `data.db` 생성 확인. 커밋.

---

### Task 2: 금고 암호화 순수 함수 (TDD)

**Files:** Create `src/main/vault/crypto.ts`; Test `tests/vault-crypto.test.ts`

**Interfaces:** `deriveKey(password: string, salt: Uint8Array): Promise<Buffer>`(32B, argon2id m=65536 t=3 p=1), `randomBytes(n)`, `encrypt(key, plaintext: string, aad: string): { ciphertext: Buffer, iv: Buffer }`, `decrypt(key, ciphertext, iv, aad): string`(실패 시 throw), `makeVerifier(key)`/`checkVerifier(key, blob)`.

- [ ] Step 1: 실패 테스트 — 같은 비밀번호·salt → 같은 키, 다른 salt → 다른 키; encrypt→decrypt 왕복; 다른 키/aad/변조 → throw; verifier 왕복.
- [ ] Step 2: 구현 (`hash-wasm` `argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' })`, `node:crypto` `createCipheriv('aes-256-gcm')`, 태그 16B 를 ciphertext 뒤에 붙임). 테스트에서 memorySize 는 환경변수로 8192 로 낮춰 속도 확보(`VAULT_KDF_MEM`).
- [ ] Step 3: 통과·커밋.

---

### Task 3: VaultService + 저장소 + IPC (TDD, sql.js 메모리 DB)

**Files:** Create `src/main/vault/{service,repo}.ts`, `src/shared/vault.ts`; Modify `src/main/ipc/handlers.ts`, `src/preload/renderer.ts`, `src/renderer/src/types/samba.d.ts`, `src/shared/ipc.ts`(채널), `src/shared/settings.ts`(`vaultAutoLockMinutes` 기본 15, `vaultRememberDevice` 기본 false); Test `tests/vault-service.test.ts`

**Interfaces (shared/vault.ts):**
```ts
export type VaultItemType = 'login_password'|'payment_password'|'card'|'passport'|'id_card'|'birth_date'|'address'|'phone'|'custom'
export interface SiteDto { id: number; host: string; name: string; loginUrl?: string }
export interface AccountDto { id: number; siteId: number; host: string; label: string; username: string; isDefault: boolean; itemTypes: VaultItemType[] }
export interface VaultItemMeta { id: number; accountId: number | null; type: VaultItemType; label: string; updatedAt: number } // 값 없음
export type VaultState = 'uninitialized' | 'locked' | 'unlocked'
```
**VaultService:** `state()`, `setup(master)`, `unlock(master): Promise<boolean>`, `lock()`, `touch()`(자동잠금 타이머 리셋), `listSites()`, `listAccounts(host?)`, `listItems(accountId | null)`, `upsertAccount(dto)`, `putItem({accountId,type,label,value})`, `deleteItem(id)`, `reveal(id): string`(감사 로그 'reveal'), `getSecretForFill(accountId, type): string | null`(감사 'fill', **호출자는 메인 내부만**), `pendingCapture` set/take(60초 TTL).
**IPC:** `vault:state`, `vault:setup`, `vault:unlock`, `vault:lock`, `vault:sites`, `vault:accounts`, `vault:items`, `vault:putItem`, `vault:deleteItem`, `vault:reveal`, `vault:upsertAccount`, `vault:stateChanged`(push), `vault:capturePrompt`(push `{host, username}` 만), `vault:captureDecision`(renderer→main `{accept:boolean}`).

- [ ] Step 1: 실패 테스트 — setup→state unlocked; lock→unlocked false; 잘못된 master unlock false; putItem 후 listItems 에 값 없음(`ciphertext` 노출 안 됨); reveal 은 잠금 시 throw; getSecretForFill 왕복; 자동잠금 타이머(가짜 타이머).
- [ ] Step 2: 구현. 잠금 해제 키는 서비스 인스턴스 필드에만. `vaultRememberDevice` 켜면 `safeStorage.encryptString(key.toString('base64'))` 를 `vault_meta.device_wrapped_key` 에 저장, 시작 시 복호화 시도(실패 시 잠김 유지).
- [ ] Step 3: IPC 핸들러·preload API·타입. 핸들러는 값 반환하는 `vault:reveal` 외에 어떤 채널도 비밀값을 보내지 않는지 코드 리뷰 체크리스트에 명시.
- [ ] Step 4: 통과·빌드·커밋.

---

### Task 4: 가져오기 파서 (TDD, 순수 함수)

**Files:** Create `src/main/import/{passwords-csv,bookmarks-html}.ts`; Test `tests/import-csv.test.ts`, `tests/import-bookmarks.test.ts`

**Interfaces:** `parsePasswordCsv(text): { rows: ParsedLogin[]; skipped: number }` with `ParsedLogin { name, url, host, username, password, note }` — 헤더 `name,url,username,password,note`(크롬/웨일/엣지 공통; `login_uri`/`login_username`(Bitwarden) 별칭도 인식), 따옴표·쉼표·개행 포함 값(papaparse), 빈 username/password 행은 skipped. `normalizeHost(url)`: `www.` 제거, 포트 제거, 소문자. `parseNetscapeBookmarks(html): BookmarkTree` — `<DL><DT><H3>` 폴더 재귀, `<A HREF ADD_DATE>` 링크, `PERSONAL_TOOLBAR_FOLDER` 표시, 폴더/링크 순서 유지, 중복 URL 제거 옵션.

- [ ] Step 1: 실패 테스트(합성 데이터 6~8행, 중첩 폴더 2단계 HTML).
- [ ] Step 2: 구현. `node-html-parser` 로 DOM 순회(`DL` 자식의 `DT` → `H3` 이면 폴더, `A` 면 링크).
- [ ] Step 3: 통과·커밋.

---

### Task 5: 가져오기 서비스 + IPC + 감사 로그

**Files:** Create `src/main/import/service.ts`, `src/main/bookmarks/repo.ts`; Modify handlers/preload/types

**Interfaces:** `import:passwords` → `dialog.showOpenDialog({filters:[{name:'CSV',extensions:['csv']}]})` → `parsePasswordCsv` → 호스트별 `sites` upsert, `(host, username)` 로 계정 중복 시 비밀번호만 갱신, 신규면 accounts+vault_items(login_password) 생성 → `ImportResult { total, added, updated, skipped, sites }`. 잠금 상태면 `{ok:false, error:'locked'}`. `import:bookmarks` → `bookmark_folders/bookmarks` 저장(기존 같은 URL 은 건너뜀) → `{ folders, bookmarks, skipped }`. `bookmarks:tree` → 트리 DTO.
- [ ] 구현 + 통합 테스트(메모리 DB + 합성 CSV/HTML) + 커밋. CSV 텍스트는 파싱 후 즉시 변수 해제, 로그에 행 내용 출력 금지.

---

### Task 6: preload — 값 주입·로그인 필드 탐지·폼 제출 감지

**Files:** Modify `src/preload/page-core.ts`, `src/preload/page.ts`, `src/main/browser/page-bridge.ts`; Test `tests/page-login.test.ts`(jsdom)

**Interfaces (격리 월드 `__samba`):** `fillValue(id, value): string`(SECRET 칸 허용 — 메인이 직접 호출할 때만; 값 세터 + input/change 이벤트), `findLoginFields(): { username?: number; password?: number; submit?: number }`(휴리스틱: `type=password` 첫 번째; username = 그 앞의 보이는 text/email/tel 입력 중 `autocomplete` username/email 또는 name/id 에 id|user|email|login|phone 포함; submit = 같은 form 의 submit 버튼 또는 텍스트 '로그인|Login|Sign in'), `submitForm(id): string`.
**폼 제출 감지:** `document.addEventListener('submit', …, true)` 에서 password 필드 값과 username 후보 값을 읽어 `ipcRenderer.send('vault:capture', { host: location.host, username, password })` — preload 격리 월드에서 `ipcRenderer` 사용 가능. 값은 이 채널로만, 메인 `pendingCapture` 로.
**page-bridge:** `fillValue(tab, id, value)` 는 `executeJavaScriptInIsolatedWorld(999, [{ code: \`__samba.fillValue(${id}, ${JSON.stringify(value)})\` }])` — 값이 코드 문자열에 들어가므로 **로그·오류 메시지에 code 를 포함하지 않도록** try/catch 에서 메시지만 반환. `findLoginFields(tab)`, `submitForm(tab, id)`.
- [ ] jsdom 테스트: 로그인 폼 픽스처에서 username/password/submit id 탐지, fillValue 로 값 세팅·이벤트 발생, submit 감지 핸들러가 콜백에 host/username/password 전달(ipcRenderer 는 주입 가능한 함수로 분리해 테스트).
- [ ] 구현·커밋.

---

### Task 7: AI 도구 — list_accounts / fill_secret / login + 권한 연동

**Files:** Modify `src/main/agent/tools.ts`, `src/main/agent/prompt.ts`, `src/main/agent/runner.ts`(ToolContext 에 vault); Test `tests/agent-vault-tools.test.ts`

- `list_accounts({host?})` → `ctx.vault.listAccounts(host ?? 현재 탭 host)` 를 `{label, username: mask(username), types}` 로. `mask`: 앞 2자 + `***`.
- `fill_secret({elementId, itemType, accountLabel?})` → read_only 거부; 잠금이면 `'locked: ask the user to unlock 개인정보'`; guard 모드에서 `payment_password|card` 는 `ctx.confirm(\`개인정보 입력: ${itemType}\`)`; 값 = `vault.getSecretForFill(account.id, itemType)` → `pageBridge.fillValue(tab, elementId, value)` → `'ok'`. 도구 결과·step 라벨에 값 없음(`입력: 결제 비밀번호 (#12)`).
- `login({accountLabel?})` → `findLoginFields` → 없으면 `'fields not found: navigate to the login page first'`; 계정 선택(라벨 지정 > isDefault > 유일) → username 은 `fillValue`(평문 OK), password 는 `getSecretForFill` → `fillValue` → `submitForm` → `waitForLoad` → `'submitted: check the page for success or captcha/2FA'`.
- 프롬프트에 규칙: 로그인이 필요하면 `login` 도구를 쓰고 비밀번호를 직접 입력하려 하지 말 것; `list_accounts` 로 계정 확인.
- [ ] 테스트: vault/pageBridge mock 으로 ① read_only 거부 ② 잠금 메시지 ③ guard+card → confirm ④ login 성공 경로에서 fillValue 가 password 값으로 호출되지만 도구 반환 문자열엔 값이 없음 ⑤ 도구 결과 텍스트에 비밀번호 문자열 미포함(정규식 assert).
- [ ] 구현·커밋.

---

### Task 8: 개인정보 페이지 UI (목업 02-vault 기준) + 뷰 전환

**Files:** Create `src/renderer/src/pages/PersonalInfoPage.tsx`, `components/vault/{UnlockScreen,SetupScreen,ItemList,ItemDetail,ItemEditor,ImportPanel}.tsx`, `stores/vaultStore.ts`; Modify `uiStore.ts`(`view: 'browser'|'personal'`), `Sidebar.tsx`(클릭으로 뷰 전환, 활성 표시), `App.tsx`(view 에 따라 가운데 카드 내용 교체; `browser` 가 아니면 `layout.set` 으로 웹뷰 bounds 를 0 으로 접어 숨김), i18n ko/en(`vault.*` 키 30여 개)

- SetupScreen: 마스터 비밀번호 2회 입력(8자 이상), "이 PC에서 기억" 체크, 경고 문구(분실 시 복구 불가). UnlockScreen: 비밀번호 1칸 + 잠금 해제.
- ItemList: 왼쪽 300px — 검색, 칩(전체/KR/CN/JP 는 2b, 지금은 전체/전역), 사이트별 그룹(호스트 아이콘 = 첫 글자 검정 원), 계정 행(라벨·마스킹 아이디), 전역 항목.
- ItemDetail: 헤더(사이트·라벨·"브라우저에서 열기"→탭 생성·"편집"), 섹션 로그인(아이디 복사 / 비밀번호 `••••` 보기·복사 → `vault:reveal`), 결제·본인정보 섹션(항목 있으면), 사용 기록(`audit_log` 최근 10).
- ItemEditor(모달): 계정 라벨·아이디·사이트 호스트·항목 타입별 값 입력(password 필드), 저장 → `vault:putItem`.
- ImportPanel: 버튼 2개(비밀번호 CSV / 북마크 HTML) → 결과 요약(추가/갱신/건너뜀) + "원본 CSV 삭제 권장" 안내.
- 애플 스타일(1단계와 동일 토큰), 브랜드 컬러 없음, 모든 문자열 `t()`.
- [ ] 구현 → `pnpm dev` 수동 확인(설정→잠금→해제→가져오기→목록→보기) → 커밋.

---

### Task 9: 자동 저장 제안 카드 + 북마크 사이드바

**Files:** Create `components/vault/CapturePrompt.tsx`, `components/layout/BookmarkTree.tsx`, `stores/bookmarkStore.ts`; Modify `ChatPanel.tsx`(카드 위치: 메시지 목록 상단 고정), `Sidebar.tsx`(북마크 섹션: 폴더 접기/펼치기, 클릭 → `tabs.navigate`), handlers(`vault:capturePrompt` push)

- 메인: `vault:capture` 수신 → 같은 (host, username) 에 동일 값 있으면 무시 → `pendingCapture` 저장(60초) → 렌더러에 `{host, username, isNew}` push. 렌더러 카드 "OO 계정 정보를 저장할까요?" [이번만 건너뛰기][저장] → `vault:captureDecision`. 잠금 상태면 카드에 "잠금 해제 후 저장" 버튼 → UnlockScreen 모달.
- [ ] 구현·수동 확인(실제 사이트 로그인 1회 → 카드 → 저장 → 개인정보 페이지에 반영)·커밋.

---

### Task 10: 자동 로그인 검증 + 문서

**Files:** Create `docs/검수/2026-09-XX-2단계-자동로그인.md`; Modify `docs/실행방법.md`, `README.md`

- [ ] 컨트롤러가 수행: 실제 CSV 가져오기(건수 요약만 기록) → 대표 사이트 5~10개에 "OO 로그인해" → 표(사이트·폼 인식·채움·제출·결과·원인). 규칙: 사이트당 1회, 캡차/2FA 시 중단·기록, 값 미기록.
- [ ] 실행방법에 "개인정보 설정·가져오기" 절 추가, README 상태 갱신, 알려진 한계(보안 키패드·2FA 는 3단계).
- [ ] `pnpm test && pnpm lint && pnpm build` → 커밋.

---

## 자체 점검
- 스펙 커버리지: DB(T1) · 암호화/잠금(T2,T3) · 가져오기(T4,T5) · 자동 채움·로그인 도구(T6,T7) · 개인정보 화면(T8) · 자동 저장 제안·북마크(T9) · 검증·문서(T10). 2b 제외 항목(Supabase·AI 설정·Recorder) 없음 확인.
- 비밀값 경로: 값이 흐르는 곳 = `vault:capture`(preload→main), `getSecretForFill`(main 내부), `fillValue` code 인자(main→격리 월드), `vault:reveal`(main→renderer, 사용자 클릭). 그 외 채널·이벤트·로그 금지 — T3/T6/T7 테스트로 단언.
- 타입 일관성: `AccountDto.itemTypes` ↔ `list_accounts.types`; `VaultItemType` 공용; IPC 채널명 `src/shared/ipc.ts` 한 곳.
