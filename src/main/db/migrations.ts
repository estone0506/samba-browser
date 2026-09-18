// drizzle-kit generate 로 만든 SQL 을 번들에 포함한다(런타임 파일 경로 문제 회피)
export interface Migration {
  tag: string
  sql: string[]
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
  }
]
