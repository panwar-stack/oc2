ALTER TABLE `geo_stat` ADD `cache_write_tokens` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_stat` ADD `cache_write_tokens` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_stat` ADD `cache_write_tokens` bigint DEFAULT 0 NOT NULL;