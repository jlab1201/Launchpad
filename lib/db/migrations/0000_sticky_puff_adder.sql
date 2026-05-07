CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`webapp_id` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`nonce` blob NOT NULL,
	`kind` text DEFAULT 'password' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`webapp_id`) REFERENCES `webapps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vault_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`kdf_salt` blob,
	`kdf_params` text,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webapps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auto_screenshot` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL
);
