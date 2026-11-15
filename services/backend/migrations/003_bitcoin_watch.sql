CREATE TABLE IF NOT EXISTS btc_accounts (
 id TEXT PRIMARY KEY, public_json TEXT NOT NULL,
 next_external INTEGER NOT NULL DEFAULT 0, next_change INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS btc_sessions (
 watch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES btc_accounts(id)
);
CREATE INDEX IF NOT EXISTS btc_session_owner ON btc_sessions(session_id);
