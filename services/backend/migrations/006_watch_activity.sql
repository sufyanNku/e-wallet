ALTER TABLE watched_accounts ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX watched_account_activity ON watched_accounts(last_active_at);
