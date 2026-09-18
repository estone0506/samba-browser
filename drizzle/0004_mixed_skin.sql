ALTER TABLE `accounts` ADD `urls` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `agent_access` text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `vault_items` ADD `fields` text;