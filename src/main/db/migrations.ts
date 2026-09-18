// drizzle-kit generate 로 만든 SQL 을 번들에 포함한다(런타임 파일 경로 문제 회피)
export interface Migration {
  tag: string
  sql: string[]
  // 이 태그들 중 하나가 __migrations 에 이미 있으면, 태그 이름만 바뀐 것으로 보고
  // SQL 을 다시 실행하지 않는다(drizzle-kit generate 재실행으로 태그가 바뀌는 경우 대비)
  aliases?: string[]
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
  }
]
