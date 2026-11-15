CREATE TABLE watched_accounts (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 network_id TEXT NOT NULL, address TEXT NOT NULL, descriptor_ref TEXT,
 watch_start TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'syncing', added_at TEXT NOT NULL,
 UNIQUE(session_id, network_id, address)
);
CREATE TABLE assets (
 asset_key TEXT PRIMARY KEY, network_id TEXT NOT NULL, standard TEXT NOT NULL,
 reference TEXT NOT NULL, token_id TEXT NOT NULL DEFAULT '', decimals INTEGER,
 symbol TEXT, name TEXT, canonical_asset_key TEXT, metadata_json TEXT
);
CREATE TABLE balance_snapshots (
 watch_id TEXT NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
 asset_key TEXT NOT NULL, height TEXT NOT NULL, block_hash TEXT,
 amount TEXT NOT NULL, observed_at TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(watch_id,asset_key,height)
);
CREATE TABLE transactions (
 network_id TEXT NOT NULL, hash TEXT NOT NULL, height TEXT, block_hash TEXT,
 status TEXT NOT NULL, from_address TEXT, to_address TEXT, fee TEXT,
 created_at TEXT NOT NULL, value TEXT NOT NULL DEFAULT '0', data_json TEXT NOT NULL,
 canonical INTEGER NOT NULL DEFAULT 1, last_observed_at TEXT NOT NULL,
 PRIMARY KEY(network_id,hash)
);
CREATE INDEX transaction_height ON transactions(network_id,height);
CREATE TABLE transfers (
 network_id TEXT NOT NULL, tx_hash TEXT NOT NULL, event_index TEXT NOT NULL,
 asset_key TEXT NOT NULL, amount TEXT NOT NULL, from_address TEXT, to_address TEXT,
 canonical INTEGER NOT NULL DEFAULT 1, data_json TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(network_id,tx_hash,event_index)
);
CREATE INDEX transfer_participants ON transfers(network_id,from_address,to_address);
CREATE TABLE sync_cursors (
 watch_id TEXT NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, position TEXT NOT NULL, inclusion_hash TEXT,
 backfill_start TEXT NOT NULL, last_synced_at TEXT, error_code TEXT,
 next_poll_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(watch_id,kind)
);
CREATE TABLE contract_events (
 network_id TEXT NOT NULL, contract_address TEXT NOT NULL, tx_hash TEXT NOT NULL,
 event_index TEXT NOT NULL, event_name TEXT NOT NULL, payload_json TEXT NOT NULL,
 canonical INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(network_id,tx_hash,event_index)
);
CREATE TABLE metadata_cache (
 asset_key TEXT PRIMARY KEY, status TEXT NOT NULL, url_hash TEXT,
 content_hash TEXT, metadata_json TEXT, expires_at TEXT, source TEXT NOT NULL
);
CREATE TABLE notification_receipts (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 network_id TEXT NOT NULL, tx_hash TEXT NOT NULL, state TEXT NOT NULL,
 delivered_at TEXT NOT NULL, read_at TEXT,
 PRIMARY KEY(session_id,network_id,tx_hash,state)
);
