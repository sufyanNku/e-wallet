ALTER TABLE watched_accounts ADD COLUMN fingerprint TEXT;
ALTER TABLE transactions ADD COLUMN fingerprint TEXT;
CREATE INDEX transaction_watch_epoch ON transactions(network_id,fingerprint,canonical);
