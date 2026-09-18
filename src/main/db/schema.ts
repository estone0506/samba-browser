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
  // 서버(Supabase)의 uuid. 아직 올리지 않았으면 null
  remoteId: text('remote_id'),
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
  remoteId: text('remote_id'),
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
  remoteId: text('remote_id'),
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
