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
  siteId: integer('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  username: text('username').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  pausedUntil: integer('paused_until'),
  // 계정당 여러 로그인 URL(JSON string[]). 옛 sites.login_url 이 여기로 이월된다
  urls: text('urls'),
  // 항목별 AI 접근 정책. 'inherit' 면 전역 설정을 따른다
  agentAccess: text('agent_access').notNull().default('inherit'),
  // 사용자 태그(JSON string[])
  tags: text('tags'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // 서버(Supabase)의 uuid. 아직 올리지 않았으면 null(NULL 은 여러 행이 가질 수 있다)
  remoteId: text('remote_id').unique(),
  workspaceId: integer('workspace_id'),
  // 삭제 표식(tombstone). 값이 있으면 지워진 행으로 본다
  deletedAt: integer('deleted_at')
})
// 비밀 항목 — 값은 항상 암호문
export const vaultItems = sqliteTable('vault_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  label: text('label').notNull(),
  // 섹션>필드 구조(JSON). secret 필드는 {ciphertext,iv} 를 base64 로 같은 JSON 안에 담고,
  // 그 외 필드는 평문 value 를 담는다. 아래 ciphertext/iv 컬럼은 v1 롤백 여유로 남겨 둔 잔재다
  fields: text('fields'),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  iv: blob('iv', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
  remoteId: text('remote_id').unique(),
  workspaceId: integer('workspace_id'),
  deletedAt: integer('deleted_at')
})
export const vaultMeta = sqliteTable('vault_meta', {
  key: text('key').primaryKey(),
  value: blob('value', { mode: 'buffer' }).notNull()
})
export const bookmarkFolders = sqliteTable('bookmark_folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentId: integer('parent_id'),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  isToolbar: integer('is_toolbar').notNull().default(0),
  addDate: integer('add_date')
})
export const bookmarks = sqliteTable('bookmarks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  folderId: integer('folder_id').references(() => bookmarkFolders.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  position: integer('position').notNull().default(0),
  addedAt: integer('added_at'),
  remoteId: text('remote_id').unique(),
  workspaceId: integer('workspace_id'),
  // 북마크는 원래 수정 시각이 없었다. 합집합 병합에서 어느 쪽 제목·순서를 쓸지 가리는 데 쓴다
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at')
})
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  itemId: integer('item_id'),
  // 항목이 삭제된 뒤에도 "어느 계정의 기록인지" 알 수 있도록 남기는 스냅샷.
  // vault_items 조인만으로는 삭제 기록이 사용 기록에서 사라진다
  accountId: integer('account_id'),
  action: text('action').notNull(),
  jobId: text('job_id'),
  source: text('source').notNull()
})

// 작업공간(브라우저 프로필) — 북마크·금고 항목·설정 세트를 가르는 상위 계층.
// 이 표는 2b 에서 동기화하지 않는다(2c 예정) — remote_id 는 항상 null 이다
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 서버(Supabase)의 uuid. 아직 올리지 않았으면 null
  remoteId: text('remote_id').unique(),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at')
})

// AI 채팅 — 대화 한 건. 제목은 첫 사용자 메시지에서 자동으로 짓는다
export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  remoteId: text('remote_id').unique(),
  workspaceId: integer('workspace_id'),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at')
})

// AI 채팅 메시지. content 는 평문이다 — 채팅은 비밀값이 아니다(스펙).
// steps 는 진행 로그 JSON 이고 label/ok/key 만 담는다(shared/chat.ts 의 sanitizeSteps)
export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  remoteId: text('remote_id').unique(),
  chatId: integer('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  // 'user' | 'assistant' | 'system'
  role: text('role').notNull(),
  content: text('content').notNull(),
  steps: text('steps'),
  createdAt: integer('created_at').notNull(),
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
  error: text('error'),
  // 이 변경이 일어난 작업공간(로컬 id). 푸시가 행마다 원격 uuid 를 고르는 데 쓴다.
  // 0007 이전에 쌓인 행은 NULL — 그때는 푸시 시점의 활성 작업공간으로 본다
  workspaceId: integer('workspace_id')
})

// 연결된 폰. PC 별 정보라 동기화하지 않는다(remote_id 컬럼이 없다)
export const phones = sqliteTable('phones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serial: text('serial').notNull().unique(),
  label: text('label').notNull(),
  // 'KR' | 'CN' | 'JP'
  country: text('country').notNull(),
  // 'usb' | 'wifi'
  transport: text('transport').notNull(),
  wifiAddress: text('wifi_address'),
  model: text('model').notNull().default(''),
  // 문자 DB 조회 가능 여부. NULL 이면 아직 시험 조회 전
  smsQueryOk: integer('sms_query_ok', { mode: 'boolean' }),
  lastSeenAt: integer('last_seen_at').notNull(),
  workspaceId: integer('workspace_id')
})

// 인증 이벤트(KPI 집계용 로컬 기록). 문자 본문은 담지 않는다 —
// 추출된 코드와 발신번호 뒷 4자리만 남긴다
export const authEvents = sqliteTable('auth_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id'),
  phoneId: integer('phone_id'),
  // 'sms' | 'app_approve' | 'ars'
  kind: text('kind').notNull(),
  siteHost: text('site_host').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  // 'sms_query' | 'visual' | 'manual'
  method: text('method').notNull(),
  elapsedMs: integer('elapsed_ms').notNull(),
  // 추출한 인증번호(숫자만) — 본문은 남기지 않는다
  code: text('code'),
  // 발신번호 뒷 4자리
  senderTail: text('sender_tail'),
  at: integer('at').notNull()
})

// 계정 ↔ 폰 매핑. 작업 시 사용자가 고르고 기억한다. 동기화하지 않는다
export const accountPhones = sqliteTable('account_phones', {
  accountId: integer('account_id').primaryKey(),
  phoneId: integer('phone_id').notNull(),
  updatedAt: integer('updated_at').notNull()
})

// 동기화 부가 상태. 'lastPulledAt' | 'deviceId' | 'userId' | 'settings:<key>:updatedAt'
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})
