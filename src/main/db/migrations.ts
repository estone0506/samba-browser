// drizzle-kit generate 로 만든 SQL 을 번들에 포함한다(런타임 파일 경로 문제 회피)
export interface Migration {
  tag: string
  sql: string[]
  // 이 태그들 중 하나가 __migrations 에 이미 있으면, 태그 이름만 바뀐 것으로 보고
  // SQL 을 다시 실행하지 않는다(drizzle-kit generate 재실행으로 태그가 바뀌는 경우 대비)
  aliases?: string[]
  // 실패해도 앱 기동을 막지 않는다(사유만 남기고 다음 기동에 다시 시도한다).
  // 데이터 정합성을 조이는 인덱스처럼 "있으면 좋지만 없어도 도는" 마이그레이션에만 쓴다
  optional?: boolean
}

/**
 * remote_id 중복을 정리하는 SQL. UNIQUE 인덱스를 걸기 전에 먼저 돌린다.
 * 같은 remote_id 가 여러 행에 있으면 가장 먼저 만들어진 행(min(id))만 남기고 나머지는
 * remote_id 를 비운다 — 다음 푸시에서 새 원격 id 를 받아 다시 짝이 맞춰진다
 */
function dedupeRemoteId(table: string): string {
  return (
    `UPDATE \`${table}\` SET \`remote_id\` = NULL WHERE \`remote_id\` IS NOT NULL ` +
    `AND \`id\` NOT IN (SELECT MIN(\`id\`) FROM \`${table}\` WHERE \`remote_id\` IS NOT NULL GROUP BY \`remote_id\`);`
  )
}

export const migrations: Migration[] = [
  {
    tag: '0000_lying_smiling_tiger',
    sql: [
      'CREATE TABLE `accounts` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`site_id` integer NOT NULL,\n\t`label` text NOT NULL,\n\t`username` text NOT NULL,\n\t`is_default` integer DEFAULT false NOT NULL,\n\t`paused_until` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade\n);',
      'CREATE TABLE `audit_log` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`at` integer NOT NULL,\n\t`item_id` integer,\n\t`action` text NOT NULL,\n\t`job_id` text,\n\t`source` text NOT NULL\n);',
      'CREATE TABLE `bookmark_folders` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`parent_id` integer,\n\t`name` text NOT NULL,\n\t`position` integer DEFAULT 0 NOT NULL\n);',
      'CREATE TABLE `bookmarks` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`folder_id` integer,\n\t`title` text NOT NULL,\n\t`url` text NOT NULL,\n\t`position` integer DEFAULT 0 NOT NULL,\n\t`added_at` integer,\n\tFOREIGN KEY (`folder_id`) REFERENCES `bookmark_folders`(`id`) ON UPDATE no action ON DELETE cascade\n);',
      'CREATE TABLE `sites` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`host` text NOT NULL,\n\t`name` text NOT NULL,\n\t`login_url` text,\n\t`created_at` integer NOT NULL\n);',
      'CREATE UNIQUE INDEX `sites_host_unique` ON `sites` (`host`);',
      'CREATE TABLE `vault_items` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`account_id` integer,\n\t`type` text NOT NULL,\n\t`label` text NOT NULL,\n\t`ciphertext` blob NOT NULL,\n\t`iv` blob NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade\n);',
      'CREATE TABLE `vault_meta` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` blob NOT NULL\n);'
    ]
  },
  {
    tag: '0001_foamy_puma',
    sql: ['ALTER TABLE `bookmark_folders` ADD `is_toolbar` integer DEFAULT 0 NOT NULL;']
  },
  {
    tag: '0002_fat_ender_wiggin',
    sql: ['ALTER TABLE `audit_log` ADD `account_id` integer;']
  },
  {
    // drizzle-kit generate 가 임의로 지어 준 이름. 예전에 손으로 붙였던
    // '0003_add_bookmark_folder_add_date' 태그가 이미 적용된 DB 도 호환되도록 alias 를 둔다
    tag: '0003_bouncy_quasar',
    sql: ['ALTER TABLE `bookmark_folders` ADD `add_date` integer;'],
    aliases: ['0003_add_bookmark_folder_add_date']
  },
  {
    // 금고 v2 — 계정 다중 URL·항목별 AI 접근 정책·태그, 항목의 섹션>필드 JSON.
    // 컬럼만 추가하고, 기존 데이터 변환은 migrate-vault-v2.ts 가 따로 수행한다
    tag: '0004_mixed_skin',
    sql: [
      'ALTER TABLE `accounts` ADD `urls` text;',
      "ALTER TABLE `accounts` ADD `agent_access` text DEFAULT 'inherit' NOT NULL;",
      'ALTER TABLE `accounts` ADD `tags` text;',
      'ALTER TABLE `vault_items` ADD `fields` text;'
    ],
    aliases: ['0004_vault_v2']
  },
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
  },
  {
    // remote_id 는 원격 행과 1:1 이라 schema.ts 에서 unique 로 선언돼 있는데,
    // 0005 에는 인덱스가 빠져 있었다. SQLite 의 UNIQUE 는 NULL 을 여러 개 허용하므로
    // 아직 올리지 않은 행(remote_id IS NULL)은 그대로 공존한다.
    //
    // 인덱스가 없던 동안 중복이 이미 생긴 DB 가 있을 수 있다 — 그대로 인덱스를 걸면
    // 마이그레이션이 던져 앱이 아예 뜨지 못한다. 그래서 (1) 중복을 먼저 정리하고,
    // (2) IF NOT EXISTS 로 걸고, (3) 그래도 실패하면 기동은 막지 않는다(optional)
    tag: '0006_remote_id_unique',
    optional: true,
    sql: [
      dedupeRemoteId('accounts'),
      dedupeRemoteId('vault_items'),
      dedupeRemoteId('bookmarks'),
      'CREATE UNIQUE INDEX IF NOT EXISTS `accounts_remote_id_unique` ON `accounts` (`remote_id`);',
      'CREATE UNIQUE INDEX IF NOT EXISTS `vault_items_remote_id_unique` ON `vault_items` (`remote_id`);',
      'CREATE UNIQUE INDEX IF NOT EXISTS `bookmarks_remote_id_unique` ON `bookmarks` (`remote_id`);'
    ]
  },
  {
    // 변경 로그에 작업공간(로컬 id)을 남긴다. 예전에는 푸시 시점의 활성 작업공간 uuid 를
    // 모든 대기 행에 찍어, 작업공간을 바꾸기 전에 쌓인 변경이 새 작업공간으로 올라갔다.
    // 옛 행(NULL)은 푸시 때 활성 작업공간으로 본다
    tag: '0007_outbox_workspace',
    sql: ['ALTER TABLE `sync_outbox` ADD `workspace_id` integer;']
  },
  {
    // AI 채팅 기록 — 대화(chats)와 메시지(chat_messages).
    // 메시지 본문은 평문으로 둔다(채팅은 비밀값이 아니다). 진행 로그(steps)는 라벨만 담는다
    tag: '0008_chats',
    sql: [
      'CREATE TABLE `chats` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`remote_id` text,\n\t`workspace_id` integer,\n\t`title` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer\n);',
      'CREATE UNIQUE INDEX `chats_remote_id_unique` ON `chats` (`remote_id`);',
      'CREATE TABLE `chat_messages` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`remote_id` text,\n\t`chat_id` integer NOT NULL,\n\t`role` text NOT NULL,\n\t`content` text NOT NULL,\n\t`steps` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tFOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade\n);',
      'CREATE UNIQUE INDEX `chat_messages_remote_id_unique` ON `chat_messages` (`remote_id`);',
      'CREATE INDEX `chat_messages_chat_idx` ON `chat_messages` (`chat_id`);'
    ]
  }
]
